import type { ChatMessage, ContentPart } from '../agents/jit-builder';

/**
 * Which slice of the window a row belongs to. Three groups is the whole story: what the *agent's
 * configuration* costs (`system`), what the *toolset* costs before a single call is made (`tools`),
 * and what the *conversation itself* has accumulated (`conversation`). Compaction can only ever
 * touch the third, which is exactly why the split is worth drawing.
 */
export type UsageGroup = 'system' | 'tools' | 'conversation';

export interface UsageSegment {
  /** Stable row key — a slug of the block title, or the role for conversation rows. */
  id: string;
  label: string;
  group: UsageGroup;
  /** `null` when the inference host refused to tokenize (non-llama.cpp server). */
  tokens: number | null;
  /** How many messages/blocks folded into this row (a session has many `tool` messages, one row). */
  count: number;
}

export interface PromptUsageBreakdown {
  segments: UsageSegment[];
  /** Sum of the segments — excludes the chat template's own per-message scaffolding. */
  sum: number;
  /** Exact templated prompt total, when the host can render it. Always ≥ `sum`. */
  total: number | null;
  contextWindow: number;
  /**
   * Ordered titles of the `## ` blocks found in the assembled system message — the prompt's *shape*
   * as it was actually sent. Placeholder surface for the prompt-module system: today these are the
   * hard-coded `jit-builder` renderers, tomorrow they are the enabled modules.
   */
  modules: string[];
}

/**
 * The blocks `buildSystemMessage` glues on *before* the operator's own prompt, and the ones it glues
 * on *after*. Knowing the two lists by name is what lets the authored prompt be found without
 * trusting the `---` separators — an `AGENTS.md` or a notebook is markdown, and markdown has
 * horizontal rules in it, so a separator search lands inside the operator's own text and swallows
 * every block after it.
 */
const HEAD_BLOCKS = new Set([
  'Environment',
  'Local Parameters',
  'House rules',
  'AGENTS.md',
  'Orchestration',
  'Tool use',
]);
const TAIL_BLOCKS = new Set(['Notebook', 'Task list', 'Auto loop']);

/** The fence `buildSystemMessage` puts on either side of the operator-authored `system_prompt`. */
const AUTHORED_SEPARATOR = '\n\n---\n\n';

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'block';
}

/** Flatten a captured message's content to the plain text the tokenizer should size. */
export function messageText(msg: unknown): string {
  const m = msg as ChatMessage | undefined;
  if (!m) return '';
  const body =
    typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? (m.content as ContentPart[])
            .map((p) => (p.type === 'text' ? p.text : (p.image_url?.url ?? '')))
            .join('\n')
        : '';
  // A tool-calling assistant message often has empty content — its weight is entirely in the
  // serialized call, so size that too or the row reads as free.
  const calls = m.tool_calls?.length ? JSON.stringify(m.tool_calls) : '';
  return [body, calls].filter(Boolean).join('\n');
}

/**
 * Cut a rendered block run (`## Title\n…\n\n## Title\n…`) into titled pieces. The text before the
 * first header — there shouldn't be any, but a hand-written prompt is not obliged to cooperate —
 * comes back untitled and is folded into the authored prompt by the caller.
 */
function splitBlocks(text: string): { title: string | null; body: string }[] {
  const out: { title: string | null; body: string }[] = [];
  const re = /^## (.+)$/gm;
  let match = re.exec(text);
  if (!match) return text.trim() ? [{ title: null, body: text }] : [];
  if (match.index > 0) {
    const lead = text.slice(0, match.index);
    if (lead.trim()) out.push({ title: null, body: lead });
  }
  while (match) {
    const title = match[1]!.trim();
    const start = match.index;
    match = re.exec(text);
    out.push({ title, body: text.slice(start, match ? match.index : undefined) });
  }
  return out;
}

/**
 * Take the *assembled* system message apart again into the blocks `buildSystemMessage` glued
 * together. Every JIT block announces itself with a `## Title`, so the message cuts cleanly on those
 * headers; the operator's own `system_prompt` is then simply what is left once the known leading and
 * trailing blocks are peeled off either end. Anything unrecognised in the middle — a `## ` heading
 * inside the authored prompt, a future prompt module — stays with the authored prompt rather than
 * being invented as a row.
 */
function splitSystemMessage(content: string, assembled = true): { title: string | null; body: string }[] {
  const parts = splitBlocks(content);
  if (!parts.length) return content.trim() ? [{ title: null, body: content }] : [];
  // Only the turn's *first* system message is the JIT assembly. A later one — the recalled-memory
  // injection — is a single self-titled block and must keep its title rather than be peeled.
  if (!assembled) return parts;

  let head = 0;
  while (head < parts.length && parts[head]!.title && HEAD_BLOCKS.has(parts[head]!.title!)) head += 1;
  let tail = parts.length;
  while (tail > head && parts[tail - 1]!.title && TAIL_BLOCKS.has(parts[tail - 1]!.title!)) tail -= 1;

  // The authored prompt carries no header of its own, so `splitBlocks` leaves it attached to the
  // block above — all of it, when the prompt contains no `## ` heading of its own. Cut that block at
  // its *first* fence and hand back everything after. Reading the first one is safe here and only
  // here: the boundary block is always the last JIT block (`Tool use`, or `Orchestration`), both
  // hard-coded strings, never operator markdown that might carry a rule of its own.
  const boundary = head > 0 ? parts[head - 1]! : null;
  let leaked = '';
  if (boundary) {
    const cut = boundary.body.indexOf(AUTHORED_SEPARATOR);
    if (cut !== -1) {
      leaked = boundary.body.slice(cut + AUTHORED_SEPARATOR.length);
      boundary.body = boundary.body.slice(0, cut);
    }
  }

  // The closing `---` fence belongs to no block — drop it rather than billing the operator's row.
  const authored = (leaked + parts.slice(head, tail).map((p) => p.body).join(''))
    .replace(/\s*---\s*$/, '');

  return [
    ...parts.slice(0, head),
    ...(authored.trim() ? [{ title: null, body: authored }] : []),
    ...parts.slice(tail),
  ];
}

/** One text to size, tagged with the row it belongs to. */
interface Piece {
  id: string;
  label: string;
  group: UsageGroup;
  text: string;
}

/**
 * Decide *what* to weigh, without weighing it — the tokenizer round trip is the caller's job so it
 * can batch every piece of the prompt into one bounded-concurrency pass.
 *
 * The authored `system_prompt` is deliberately its own row rather than being lumped with the JIT
 * blocks: it is the one part of the system message the operator writes, so seeing it at 40% of the
 * window is actionable in a way that "system: 70%" never is.
 */
export function planUsagePieces(messages: unknown[], tools: unknown[] | undefined): Piece[] {
  const pieces: Piece[] = [];
  let systemSeen = false;

  for (const msg of messages) {
    const m = msg as ChatMessage;
    const text = messageText(m);
    if (m?.role === 'system') {
      const content = typeof m.content === 'string' ? m.content : text;
      // Only the first system message is the JIT assembly; a later one is the injected memory
      // recall, which `buildMemoryMessage` already gives a `## Memory` header.
      for (const block of splitSystemMessage(content, !systemSeen)) {
        const title = block.title ?? (systemSeen ? 'Injected system' : 'System prompt');
        pieces.push({
          id: block.title ? slug(block.title) : systemSeen ? 'injected_system' : 'system_prompt',
          label: title,
          group: 'system',
          text: block.body,
        });
      }
      systemSeen = true;
      continue;
    }
    if (m?.role === 'user') pieces.push({ id: 'user', label: 'User', group: 'conversation', text });
    else if (m?.role === 'assistant')
      pieces.push({ id: 'assistant', label: 'Assistant', group: 'conversation', text });
    else if (m?.role === 'tool')
      pieces.push({ id: 'tool_results', label: 'Tool results', group: 'conversation', text });
    else if (m)
      pieces.push({ id: m.role ?? 'other', label: m.role ?? 'Other', group: 'conversation', text });
  }

  // The toolset is billed on every single call and lives nowhere in `messages` — without this row
  // the breakdown would quietly lose the second-largest slice of a well-equipped agent's window.
  if (tools?.length) {
    pieces.push({
      id: 'tool_schemas',
      label: 'Tool schemas',
      group: 'tools',
      text: JSON.stringify(tools),
    });
  }
  return pieces;
}

/**
 * Fold the sized pieces back into one row per category, preserving first-appearance order within
 * group order (system → tools → conversation) so the list reads top-down like the prompt itself.
 */
export function foldSegments(pieces: Piece[], counts: (number | null)[]): UsageSegment[] {
  const byId = new Map<string, UsageSegment>();
  pieces.forEach((p, i) => {
    const n = counts[i] ?? null;
    const row = byId.get(p.id);
    if (!row) {
      byId.set(p.id, { id: p.id, label: p.label, group: p.group, tokens: n, count: 1 });
      return;
    }
    row.count += 1;
    if (n !== null) row.tokens = (row.tokens ?? 0) + n;
  });

  const order: UsageGroup[] = ['system', 'tools', 'conversation'];
  return [...byId.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** Ordered `## ` block titles of the assembled system message — the future module list. */
export function promptModules(messages: unknown[]): string[] {
  const first = (messages as ChatMessage[]).find((m) => m?.role === 'system');
  if (!first) return [];
  const content = typeof first.content === 'string' ? first.content : '';
  return splitSystemMessage(content)
    .map((b) => b.title)
    .filter((t): t is string => Boolean(t));
}
