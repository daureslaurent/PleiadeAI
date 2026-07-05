import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import {
  resolveInference,
  resolveFallbacks,
  resolveForEndpoint,
  type ResolvedInference,
} from '../../inference/inference-resolver';
import { settingsService } from '../settings/settings.service';
import type { AgentDoc } from '../agents/agent.model';
import type { ChatMessage } from '../agents/jit-builder';

const log = createLogger('session-titler');

const SYSTEM = [
  'You label chat conversations, like the sidebar titles in ChatGPT or Claude.',
  'Given the conversation so far, write a concise noun-phrase title naming its main topic or task —',
  'not a restatement of the user\'s message and not a reply to it. Summarise what the chat is ABOUT.',
  'If the discussion has moved on from how it opened, title it by what it has mainly become about.',
  '',
  'Rules:',
  '- 2 to 5 words, Title Case.',
  '- A topic label, not a sentence. No first/second person, no verbs like "how to" unless essential.',
  '- Same language as the conversation.',
  '- Reply with ONLY the title: no quotes, no trailing punctuation, no preamble or explanation.',
  '',
  'Examples:',
  'User: "can you help me center a div in css" -> CSS Div Centering',
  'User: "write a python script to rename files by date" -> Batch File Renaming Script',
  'User: "what were the main causes of world war 1" -> Causes Of World War I',
  'User: "my flight got cancelled, what are my rights in the EU" -> EU Flight Cancellation Rights',
].join('\n');

/** Keep the prompt small: cap each message and the number of turns fed to the titler. */
const MAX_MSG_CHARS = 400;
const MAX_TRANSCRIPT_CHARS = 2400;

/** One line of the conversation we sent to the model. `content` accepts the JIT chat shape. */
export interface TitleTurn {
  role: 'user' | 'assistant';
  content: unknown;
}

function clamp(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Flatten a possibly multi-part chat `content` into plain text for the titler. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join(' ');
  }
  return '';
}

/**
 * Render the transcript we feed the model: the most recent turns (newest kept, oldest dropped once
 * the budget is hit), each clamped, labelled by speaker. Keeping the tail biases the title toward
 * where a long conversation has ended up rather than where it opened.
 */
function renderTranscript(turns: TitleTurn[]): string {
  const lines: string[] = [];
  let budget = MAX_TRANSCRIPT_CHARS;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const body = clamp(textOf(t.content), MAX_MSG_CHARS);
    if (!body) continue;
    const line = `${t.role === 'user' ? 'User' : 'Assistant'}: ${body}`;
    if (line.length > budget && lines.length) break;
    lines.unshift(line);
    budget -= line.length;
  }
  return lines.join('\n');
}

/**
 * Generate a concise, human-readable title for a session from its conversation so far. Best-effort:
 * on any failure (or an empty result) returns `null` so the caller keeps the existing title.
 * Runs as a small, capped inference call so it never competes with the agent's own budget.
 *
 * Pass the opening exchange on the first turn, or the accumulated transcript when re-titling a grown
 * conversation — the model is told to title by where the chat has ended up, not just how it opened.
 *
 * Target model: a specific endpoint+model when configured in Settings (`title_endpoint_id`),
 * otherwise the responding `agent`'s own endpoint+model. Either way it rides the failover chain so
 * a down endpoint still yields a title.
 */
export async function generateSessionTitle(
  turns: TitleTurn[],
  agent: Pick<AgentDoc, 'endpoint_id' | 'model'> | null,
): Promise<string | null> {
  try {
    const transcript = renderTranscript(turns);
    if (!transcript) return null;
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Conversation:\n${transcript}\n\nTitle:`,
      },
    ];

    const settings = await settingsService.get();
    let inference: ResolvedInference | null = null;
    // Configured override → a fixed (usually cheaper) endpoint+model for all titles.
    if (settings.title_endpoint_id) {
      inference = await resolveForEndpoint(settings.title_endpoint_id, settings.title_model);
    }
    // Default (or a since-deleted override endpoint) → reuse the agent's own target.
    if (!inference && agent) inference = await resolveInference(agent);
    const fallbacks = await resolveFallbacks(inference?.url);

    const { text } = await llamaClient.streamChat(
      messages,
      [],
      { onToken: () => {} },
      undefined,
      // Budget from Settings — must fit a reasoning model's <think> block plus the title. Too small
      // truncates mid-reasoning, leaving no closing </think> for cleanTitle to strip.
      { maxTokens: settings.title_max_tokens, temperature: 0.3 },
      inference ?? undefined,
      fallbacks,
    );
    return cleanTitle(text) || null;
  } catch (err) {
    log.warn({ err: String(err) }, 'title generation failed');
    return null;
  }
}

/** Strip reasoning tags, an echoed "Title:" prefix, wrapping quotes, and clamp the length. */
function cleanTitle(raw: string): string {
  // Remove completed <think>…</think> reasoning blocks.
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Remove a *dangling* <think> with no closing tag: the call was truncated mid-reasoning, so
  // everything from the opener onward is unfinished thought, not a title. Leaving it would surface
  // raw reasoning as the title; dropping it yields '' → caller keeps the existing title instead.
  t = t.replace(/<think>[\s\S]*$/i, '');
  // Remove a leading orphan </think> (some templates emit the opener on a separate reasoning
  // channel, so only the closing tag lands in the content) plus any reasoning preceding it.
  t = t.replace(/^[\s\S]*?<\/think>/i, '');
  t = t.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  t = t.replace(/^title\s*[:\-]\s*/i, '');
  t = t.replace(/^["'“”«»]+|["'“”«».]+$/g, '').trim();
  return t.length > 60 ? `${t.slice(0, 60).trim()}…` : t;
}
