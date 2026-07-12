import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import { resolveInference } from '../../inference/inference-resolver';
import type { AgentDoc } from '../agents/agent.model';
import type { ChatMessage } from '../agents/jit-builder';

const log = createLogger('interviewer');

/**
 * The interviewer has nothing to deliberate about — it writes one message. Suppressing the thinking
 * channel is what makes a modest budget safe: left to think, a reasoning model (PleiadesAI, the
 * observed fleet default) burns the *whole* budget inside `<think>` and returns empty content
 * (`finish: 'length'`, zero content tokens), so the conversation dies with "no question". The memory
 * distiller and the judge suppress it the same way.
 */
const NO_THINKING = { enable_thinking: false } as const;

/** Budget for one question — headroom for a model that ignores the no-thinking hint, not for prose. */
const MAX_TOKENS = 1200;
/** Deliberately hot — the whole point is a wide, non-repetitive spread of questions. */
const TEMPERATURE = 1.0;

/** Keep the transcript we feed back to the interviewer bounded on long conversations. */
const MAX_REPLY_CHARS = 1500;

/** One exchange of the conversation being generated. */
export interface Exchange {
  question: string;
  answer: string;
}

export interface InterviewerInput {
  /** The agent playing the interviewer — only its prompt is used. */
  interviewer: AgentDoc;
  /** The agent being interviewed: its charter tells the interviewer what is worth asking about. */
  target: AgentDoc;
  /** The subject drawn for this conversation ('' → the interviewer picks one from the target's charter). */
  topic: string;
  /** The conversation so far; empty on the opening question. */
  exchanges: Exchange[];
  /** Total exchanges this conversation will run to, so the interviewer can pace its follow-ups. */
  totalTurns: number;
}

function clamp(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * The situation block appended to the interviewer's own system prompt. It is *not* a second system
 * message — GGUF chat templates break on a second `system` turn (see `jit-builder`), so everything
 * is folded into one.
 */
function buildBriefing(input: InterviewerInput): string {
  const { target, topic, totalTurns } = input;
  const lines = [
    '',
    '--- THIS CONVERSATION ---',
    `You are talking to an AI agent named "${target.name}". YOU are the user; IT answers.`,
  ];
  if (target.description) lines.push(`Its stated purpose: ${target.description}`);
  if (target.system_prompt) {
    lines.push('', 'Its charter (so you know what it is meant to be good at):', clamp(target.system_prompt, 1200));
  }
  lines.push(
    '',
    topic
      ? `Subject for this conversation: ${topic}`
      : "Pick a subject squarely inside this agent's purpose, and stay on it.",
    `The conversation runs for ${totalTurns} exchange(s) in total.`,
    '',
    'Absolute rules:',
    '- You ASK. You never answer. Never write the agent\'s side of the conversation, never solve the',
    '  problem yourself, never hand it code or a finished answer — ask it for one.',
    '- Never repeat back what the agent just said.',
    '- Write ONLY your next message to it: no preamble, no quotes, no speaker labels, no stage',
    '  directions, and never mention that you are generating anything.',
  );
  return lines.join('\n');
}

/**
 * Render the conversation so far as a labelled transcript inside a single `user` turn, ending with
 * the instruction to speak next.
 *
 * The obvious alternative — replaying the interviewer's questions as `assistant` turns and the
 * agent's answers as `user` turns — reads to the model as "you are the assistant, answer the user",
 * and it duly abandons the interviewer persona and starts *answering its own question*. A transcript
 * leaves no ambiguity about who speaks next. (The session titler feeds its transcript the same way.)
 */
function buildTranscriptTurn(input: InterviewerInput): string {
  const { exchanges, target } = input;
  if (!exchanges.length) {
    return 'Open the conversation: write your first message to the agent.';
  }
  const lines = ['The conversation so far:', ''];
  for (const ex of exchanges) {
    lines.push(`YOU: ${ex.question}`);
    lines.push(`${target.name.toUpperCase()}: ${clamp(ex.answer, MAX_REPLY_CHARS) || '(no answer)'}`);
    lines.push('');
  }
  lines.push(
    `Now write your next message to ${target.name} — follow up on what it just said. Your message only.`,
  );
  return lines.join('\n');
}

/** Strip reasoning blocks, leaked speaker labels, and any attempt to write the agent's side too. */
function cleanQuestion(raw: string, targetName: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // A truncated reasoning block leaves a dangling opener (or an orphan closer when the template puts
  // the opener on a separate channel) — in both cases the surviving text is thought, not a question.
  t = t.replace(/<think>[\s\S]*$/i, '');
  t = t.replace(/^[\s\S]*?<\/think>/i, '');
  t = t.trim();
  // It copied the transcript's format back: drop its own label, and cut the moment it starts
  // ventriloquising the agent's reply — everything from that label on is not the interviewer's turn.
  t = t.replace(/^(?:you|question|interviewer|user)\s*[:\-]\s*/i, '');
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const agentLabel = new RegExp(`^\\s*(?:${escaped}|agent|assistant)\\s*:`, 'im');
  const spoken = agentLabel.exec(t);
  if (spoken) t = t.slice(0, spoken.index);
  t = t.trim().replace(/^["'“”«»]+|["'“”«»]+$/g, '');
  return t.trim();
}

/**
 * Produce the interviewer's next message: one plain, capped inference call — no tool loop, no
 * memory recall, no delegation.
 *
 * Always runs on the **fleet default** endpoint + model (`resolveInference` with no agent target),
 * whatever model the interviewer agent's own doc names. The *target* keeps its own model: it is the
 * one whose answers become training data, so it must be exercised on the model it is meant to run on.
 *
 * Returns `null` when the model gives back nothing usable — the caller ends the conversation there
 * rather than persisting an empty turn.
 */
export async function nextQuestion(input: InterviewerInput): Promise<string | null> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: `${input.interviewer.system_prompt}\n${buildBriefing(input)}` },
      { role: 'user', content: buildTranscriptTurn(input) },
    ];

    const inference = await resolveInference({ endpoint_id: null, model: '' });

    const ask = (thinking: boolean): Promise<string> =>
      runWithCaptureContext({ source: 'interview' }, () =>
        llamaClient.complete(inference, messages, {
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          chatTemplateKwargs: thinking ? undefined : NO_THINKING,
        }),
      );

    let text: string;
    try {
      text = await ask(false);
    } catch (err) {
      // Not every OpenAI-ish backend accepts `chat_template_kwargs` (same caveat the memory distiller
      // and judge handle) — retry letting it think, and lean on the `<think>` stripping below.
      log.debug({ err: String(err) }, 'no-thinking interview call rejected — retrying unconstrained');
      text = await ask(true);
    }
    const question = cleanQuestion(text, input.target.name);
    if (!question) {
      // Nothing usable: either the model said nothing, or it was cut off inside its reasoning block
      // and everything we got back was thought. Log the raw length so the cause is distinguishable.
      log.warn({ rawChars: text.length, target: input.target.name }, 'interviewer produced no question');
      return null;
    }
    return question;
  } catch (err) {
    log.warn({ err: String(err) }, 'interviewer question generation failed');
    return null;
  }
}
