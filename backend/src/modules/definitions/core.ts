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
