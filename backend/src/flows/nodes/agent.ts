import { createLogger } from '../../config/logger';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRepository } from '../../domain/agents/agent.repository';
import { agentRunner } from '../../orchestrator/AgentRunner';
import type { ImageBlock } from '../../core/event-bus/events.types';
import { asHandles, asText, handleValue, textValue } from '../port-types';
import type { FlowNodeContext, FlowNodeHandler, PortSpec } from '../types';

const log = createLogger('flow:agent-node');

/** How long an agent node waits for a live user chat on the same agent before running anyway. */
const YIELD_TIMEOUT_MS = 2 * 60_000;

/**
 * Load image handles back into `ImageBlock`s an agent turn can actually see. The handle is preserved
 * as `id` so the agent, the sub-agents it delegates to, and every later node all name the same
 * `img_N` — the property that makes artifacts flow through a graph without file paths.
 */
async function imagesFrom(ctx: FlowNodeContext, handles: string[]): Promise<ImageBlock[]> {
  const blocks: ImageBlock[] = [];
  for (const handle of handles) {
    const res = await ctx.readResource(handle);
    if (!res) {
      log.warn({ handle, runId: ctx.runId }, 'image handle not found in run session');
      continue;
    }
    blocks.push({
      id: handle,
      kind: 'image',
      mime: res.mime,
      source: 'tool',
      dataUrl: `data:${res.mime};base64,${res.bytes.toString('base64')}`,
    });
  }
  return blocks;
}

/**
 * Compose the turn's user message: the prompt template (already interpolated by the runner) plus any
 * text arriving on the `text` port. Wiring text in is the common case — "take the previous node's
 * answer and do X with it" — so it is appended rather than requiring a `{{ref}}`.
 */
function buildPrompt(config: Record<string, unknown>, wired: string): string {
  const prompt = String(config.prompt ?? '').trim();
  if (prompt && wired) return `${prompt}\n\n${wired}`;
  return prompt || wired;
}

/**
 * Run an agent turn inside a flow, yielding to a live user chat first (the same courtesy cron
 * jobs pay in `agenda.setup.ts`). Runs under the flow run's session, so the agent reaches every
 * artifact produced so far by handle, and its tokens stream to the page that is watching.
 */
async function runAgent(
  ctx: FlowNodeContext,
  agentName: string,
  userText: string,
  images: ImageBlock[],
): Promise<{ text: string; images: ImageBlock[] }> {
  const agent = await agentRepository.resolveByName(agentName);
  if (!agent) throw new Error(`agent "${agentName}" not found`);

  const free = await sessionLock.waitUntilFree(String(agent._id), YIELD_TIMEOUT_MS);
  if (!free) {
    log.info({ agentName, runId: ctx.runId }, 'agent busy with a user chat; running the flow node anyway');
  }

  ctx.emitProgress({ phase: 'running', percent: null, message: `${agentName} is thinking` });
  const result = await agentRunner.run({
    agentName,
    sessionId: ctx.sessionId,
    depth: 0,
    userText,
    images: images.length ? images : undefined,
    signal: ctx.signal,
    // A flow is a pipeline, not a conversation: writing every intermediate step into the agent's
    // long-term memory would flood its namespace with fragments of jobs it never really "had".
    persistMemory: false,
  });
  return { text: result.text, images: result.images ?? [] };
}

/**
 * `ask_agent` — hand a task to one of the operator's agents and use its answer downstream.
 *
 * The whole point of the node: an agent writes the prompt, a ComfyUI node renders it. The agent gets
 * its full toolset, memory and isolation, exactly as in chat — the flow only fixes *when* it runs and
 * *what* it is asked.
 */
export const askAgentNode: FlowNodeHandler = {
  type: 'ask_agent',
  label: 'Ask Agent',
  group: 'agent',
  description: 'Runs one of your agents with a prompt and passes its answer downstream.',
  inputs: [
    { name: 'text', types: ['text', 'json'], description: 'Appended to the prompt.' },
    { name: 'images', types: ['image'], description: 'Shown to the agent (it sees them by handle).' },
    { name: 'run', types: ['signal'], description: 'Optional ordering-only trigger.' },
  ],
  outputs: [
    { name: 'default', types: ['text'] },
    { name: 'images', types: ['image'] },
    { name: 'done', types: ['signal'] },
  ],
  config: [
    {
      key: 'agent',
      label: 'Agent',
      type: 'select',
      optionsSource: 'agents',
      default: '',
      hint: 'Which agent runs this step.',
    },
    {
      key: 'prompt',
      label: 'Prompt',
      type: 'string',
      default: '',
      hint: 'What to ask. Supports {{node_id}} references to earlier nodes.',
    },
  ],

  validate(node) {
    return String(node.config.agent ?? '').trim() ? [] : ['no agent is selected'];
  },

  async run(ctx, inputs, config) {
    const agentName = String(config.agent ?? '').trim();
    if (!agentName) throw new Error('no agent is selected for this node');

    const userText = buildPrompt(config, asText(inputs.text));
    if (!userText) throw new Error('the prompt is empty');

    const images = await imagesFrom(ctx, asHandles(inputs.images));
    const result = await runAgent(ctx, agentName, userText, images);

    // Images the agent produced are already stored under the run's session by the runner, so they
    // travel on as handles rather than being re-persisted here.
    const handles = result.images.map((i) => i.id).filter((id): id is string => Boolean(id));
    return {
      default: textValue(result.text),
      ...(handles.length ? { images: handleValue('image', handles) } : {}),
      done: { type: 'signal' as const },
    };
  },
};

/**
 * `router` — an agent decides which branch runs (flows spec §3).
 *
 * The fuzzy counterpart to `condition`: "is this image good enough?", "which department handles
 * this?" — judgements no expression can make. One `signal` output per choice; only the chosen one
 * carries a value, and the runner skips everything reachable solely through the others.
 */
export const routerNode: FlowNodeHandler = {
  type: 'router',
  label: 'Agent Router',
  group: 'agent',
  description: 'An agent picks one of several branches by answering a multiple-choice question.',
  inputs: [
    { name: 'text', types: ['text', 'json'], description: 'The material to judge.' },
    { name: 'images', types: ['image'] },
    { name: 'run', types: ['signal'] },
  ],
  outputs: [{ name: 'answer', types: ['text'] }],
  config: [
    { key: 'agent', label: 'Agent', type: 'select', optionsSource: 'agents', default: '' },
    {
      key: 'question',
      label: 'Question',
      type: 'string',
      default: '',
      hint: 'What to decide. Supports {{node_id}} references.',
    },
    {
      key: 'choices',
      label: 'Choices',
      type: 'string',
      default: 'yes, no',
      hint: 'Comma-separated. Each becomes an output branch.',
    },
  ],

  dynamicOutputs(config) {
    const ports: PortSpec[] = [{ name: 'answer', types: ['text'] }];
    for (const choice of parseChoices(config.choices)) {
      ports.push({ name: choice, types: ['signal'], description: `Taken when the answer is "${choice}".` });
    }
    return ports;
  },

  validate(node) {
    const errors: string[] = [];
    if (!String(node.config.agent ?? '').trim()) errors.push('no agent is selected');
    if (parseChoices(node.config.choices).length < 2) errors.push('at least two choices are required');
    return errors;
  },

  async run(ctx, inputs, config) {
    const agentName = String(config.agent ?? '').trim();
    if (!agentName) throw new Error('no agent is selected for this node');
    const choices = parseChoices(config.choices);
    if (choices.length < 2) throw new Error('at least two choices are required');

    const question = String(config.question ?? '').trim();
    const material = asText(inputs.text);
    const userText =
      `${question}${material ? `\n\n${material}` : ''}\n\n` +
      `Answer with exactly one of: ${choices.join(', ')}. Reply with that word alone and nothing else.`;

    const images = await imagesFrom(ctx, asHandles(inputs.images));
    const { text } = await runAgent(ctx, agentName, userText, images);

    const picked = matchChoice(text, choices);
    if (picked === null) {
      // A model that ignored the instruction shouldn't stall the pipeline — take the first branch and
      // say so in the trace, where the operator can see the answer that caused it.
      ctx.emitOutput(`router: could not match "${text.trim().slice(0, 120)}" — defaulting to "${choices[0]}"\n`);
    }
    const choice = picked ?? choices[0]!;
    return {
      answer: textValue(text.trim()),
      [choice]: { type: 'signal' as const },
    };
  },
};

/** `"yes, no"` → `['yes','no']`, de-duplicated, preserving order. */
export function parseChoices(raw: unknown): string[] {
  const seen = new Set<string>();
  return String(raw ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => (seen.has(c.toLowerCase()) ? false : (seen.add(c.toLowerCase()), true)));
}

/** Exact match first, then a contained word — models like to answer "yes, because…". */
function matchChoice(answer: string, choices: string[]): string | null {
  const text = answer.trim().toLowerCase();
  const exact = choices.find((c) => c.toLowerCase() === text);
  if (exact) return exact;
  const contained = choices.find((c) => new RegExp(`\\b${escapeRegex(c.toLowerCase())}\\b`).test(text));
  return contained ?? null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
