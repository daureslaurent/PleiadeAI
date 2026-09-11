import type { AgentDoc } from '../../domain/agents/agent.model';
import type { PromptContext, PromptModule } from '../types';

/**
 * Render an ambient "Environment" block giving the agent live situational awareness it can't
 * otherwise derive: the current wall-clock date/time (LLMs have no clock — without this they
 * hallucinate dates), its own identity, its role, and where its tools execute. Computed fresh on
 * every prompt rebuild so the timestamp is always current for the turn.
 */
export function renderEnvironmentBlock(agent: AgentDoc, now: Date = new Date()): string {
  const iso = now.toISOString();
  // Human-readable UTC rendering (deterministic across hosts, no server-locale surprises).
  const human = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(now);
  const role = agent.subagent ? 'subagent (reachable via `ask_agent`)' : 'top-level orchestrator';
  const execution = agent.isolation_id
    ? 'tools run inside your dedicated isolated container'
    : 'tools run on the backend host';
  return (
    '## Environment\n' +
    `- Current date & time: ${human} (${iso})\n` +
    `- Your name: ${agent.name}\n` +
    `- Your role: ${role}\n` +
    `- Execution: ${execution}`
  );
}

/**
 * Directive reinforcing the native tool-calling contract. Local models occasionally *narrate* a
 * tool call as prose (e.g. `[ask_user] …`) instead of emitting it on the structured function-call
 * channel — which leaks the text to the operator and never runs the tool. `AgentRunner` has a
 * best-effort fallback that recovers such calls, but the reliable fix is the model not doing it in
 * the first place, so we state the contract explicitly. Injected for every agent (all have tools).
 */
export function renderToolUseBlock(): string {
  return (
    '## Tool use\n' +
    'When you want to use a tool, invoke it through the native function-calling mechanism — do not ' +
    'announce or describe the call in your reply text. Never write a tool name in prose or brackets ' +
    '(e.g. `[ask_user]`, `[ask_agent]`) as a stand-in for calling it: such text is shown to the ' +
    'operator verbatim and does not execute the tool. Either call the tool for real, or reply ' +
    'normally without naming it.'
  );
}

/**
 * The two blocks nothing else can stand in for. Without a clock the model dates its own work
 * wrongly and never notices; without the tool-use contract it narrates calls as prose that reaches
 * the operator and runs nothing. Both are `mandatory` — the route refuses to switch them off.
 */
export const environmentModule: PromptModule = {
  id: 'environment',
  name: 'Environment',
  description: "The turn's wall-clock time, the agent's own name, role and where its tools execute.",
  group: 'core',
  mandatory: true,
  blocks: [
    {
      title: 'Environment',
      placement: 'system_head',
      order: 10,
      render: (ctx: PromptContext) => renderEnvironmentBlock(ctx.agent, ctx.now),
    },
  ],
};

export const toolUseModule: PromptModule = {
  id: 'tool-use',
  name: 'Tool use',
  description: 'The native function-calling contract — call tools, never narrate them as prose.',
  group: 'core',
  mandatory: true,
  blocks: [
    {
      title: 'Tool use',
      placement: 'system_head',
      order: 60,
      overridable: true,
      render: () => renderToolUseBlock(),
    },
  ],
};

/**
 * The tools every agent holds regardless of its `tools_allowed`: the shared resource pool, the
 * on-demand manual, and the one way back to the operator. Tools-only — they contribute no prompt
 * text, but they are part of what this instance is made of, so they get a row.
 *
 * `mandatory`, and `ask_user` is why. An agent that cannot ask has to guess, and a fleet where
 * every agent guesses is worse than one that occasionally stops — so this is not a switch.
 */
export const sessionModule: PromptModule = {
  id: 'session',
  name: 'Session',
  description: "The session's shared resource pool, the tool manual, and reaching the operator.",
  group: 'core',
  mandatory: true,
  tools: ['data', 'guide', 'ask_user'],
};

/**
 * Teach the model to *use* the tool-call array it already has.
 *
 * A local model left to itself asks for one thing, reads the answer, asks for the next — a full
 * inference pass per call, even when the two calls could not possibly affect each other. It will
 * batch when the work obviously decomposes (prod shows `read`+`read`+`bash` going out together),
 * but only sometimes, and never as a habit.
 *
 * The instruction is worth its tokens whether or not the calls then overlap: batching saves an
 * inference pass either way, and the runner only *executes* the parallel-safe ones together
 * (`tools/parallel-safety.ts`). What the block must not do is promise something this instance
 * doesn't do — so the "they run at once" sentence is written from the live setting rather than
 * assumed, and the counter-instruction (don't batch what depends on the previous answer) is stated
 * in the same breath, because a model that batches a `read` with the `edit` it implies has made
 * things worse, not faster.
 */
export function renderParallelToolsBlock(parallel: { enabled: boolean; max: number }): string {
  const executes = parallel.enabled
    ? 'They are executed at the same time where that is safe, so the batch costs about as long as ' +
      'its slowest call instead of all of them added up.'
    : 'They are executed one after another here, but asking for them together still saves you a ' +
      'whole round of thinking per call.';
  return (
    '## Calling several tools at once\n' +
    'You may put more than one tool call in a single reply. Do that whenever the calls do not ' +
    'depend on each other — reading three files, opening two threads, a search plus a directory ' +
    'listing. ' +
    executes +
    '\n' +
    'Ask for them together only when you could not have learned anything from the first that would ' +
    'change the second. If a call depends on what a previous one returns — reading a file before ' +
    'editing it, listing a directory before opening something in it — issue it on its own and wait ' +
    'for the answer. A batch built on a guess wastes the round it was meant to save.\n' +
    'You see no result until every call in the batch has come back, and they come back together, ' +
    'in the order you asked for them.'
  );
}

/**
 * Batching independent calls. A switch, not a mandate: it is an instruction about *how to work*,
 * and an operator running a small model that handles one call at a time more reliably should be
 * able to take it away without touching anything else.
 *
 * Switching this off stops the fleet being *told* to batch; whether batches that arrive anyway are
 * overlapped is `tool_parallel_enabled` on Settings → Fleet, which is a property of this backend
 * rather than of the prompt. Both are surfaced on the module's row.
 */
export const parallelToolsModule: PromptModule = {
  id: 'parallel-tools',
  name: 'Parallel tool calls',
  description: 'Tells agents to batch independent calls into one reply instead of one at a time.',
  group: 'core',
  settingsKeys: ['tool_parallel_enabled', 'tool_parallel_max'],
  blocks: [
    {
      title: 'Calling several tools at once',
      placement: 'system_head',
      order: 70,
      render: (ctx: PromptContext) => renderParallelToolsBlock(ctx.toolParallel),
    },
  ],
};
