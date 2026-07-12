import type { AgentDoc } from './agent.model';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { MemoryKind, RecalledMemory } from '../memory/memory.types';

/**
 * OpenAI-compatible chat message shapes for llama.cpp (`/v1/chat/completions`).
 * A user message's content may be a plain string or an array of typed parts, which is how
 * multimodal Base64 images ride alongside text.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Assistant-issued function call, mirrored from the OpenAI tool-calling format. */
export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  /** Present on an assistant message that requested tool execution. */
  tool_calls?: AssistantToolCall[];
}

/**
 * Render the agent's local KV parameter store as a Markdown block prepended to the system
 * prompt (spec §2). This gives the agent automated visibility over its own configuration
 * (e.g. `ssh_target`) which it can mutate via `set_agent_parameter`.
 */
export function renderParameterBlock(parameters: Map<string, string>): string {
  if (!parameters || parameters.size === 0) {
    return '## Local Parameters\n_(none set)_';
  }
  const rows = [...parameters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- \`${k}\`: ${v}`)
    .join('\n');
  return `## Local Parameters\nThese are your persistent configuration values. Use \`set_agent_parameter\` to change them.\n${rows}`;
}

/**
 * Render the fleet-wide AGENTS.md (`settings.agents_md`) as a "House rules" block. Operator-owned
 * standing instructions that bind *every* agent, subagents included. No tool can write it — the
 * agent may only read it. Empty → omitted entirely rather than advertised as blank.
 */
export function renderHouseRulesBlock(houseRules: string | undefined): string {
  const body = (houseRules ?? '').trim();
  if (!body) return '';
  return `## House rules\nStanding instructions for every agent in this fleet. You cannot edit them; follow them.\n\n${body}`;
}

/**
 * Render this agent's own AGENTS.md — its operator-authored charter. Like the house rules it is
 * read-only to the agent: it exists so standing instructions survive whatever the agent later
 * writes into its `notebook`. Empty → omitted (a blank charter is not worth prompt tokens).
 */
export function renderAgentsMdBlock(agentsMd: string | undefined): string {
  const body = (agentsMd ?? '').trim();
  if (!body) return '';
  return `## AGENTS.md\nYour operator's standing instructions for you. You cannot edit them; follow them.\n\n${body}`;
}

/**
 * Render the agent's self-owned notebook. This is the one prompt document the agent may write (via
 * `update_notebook`) — persisted conventions, learnings, and TODOs that outlive a session. Injected
 * *after* the authored system prompt so it reads as the agent's own notes, never as instruction
 * outranking the operator's AGENTS.md.
 */
export function renderNotebookBlock(notebook: string | undefined): string {
  const body = (notebook ?? '').trim();
  if (!body) {
    return '## Notebook\n_(empty — use `update_notebook` to record durable notes for your future self.)_';
  }
  return `## Notebook\nYour own notes, written by you on earlier turns. Keep them current with \`update_notebook\`.\n\n${body}`;
}

/**
 * Directive injected for top-level agents (`subagent === false`). It turns the agent into an
 * orchestrator: it must survey the `annuaire` and route work to specialised subagents rather than
 * answering everything itself. Omitted for subagents so they stay focused on their own scope.
 */
export function renderOrchestrationBlock(): string {
  return (
    '## Orchestration\n' +
    'You are a top-level agent — you coordinate a team of specialised subagents rather than ' +
    'working alone. Before you answer, call `annuaire` to review the available subagents, then ' +
    'delegate each relevant part of the request to the right one with `ask_agent`. Only handle a ' +
    'request yourself when no subagent fits it. Synthesise the subagents\' answers into a single ' +
    'coherent reply for the user.'
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
 * Compose the JIT system prompt. Ordering is deliberate and encodes who owns what:
 *
 *   environment · parameters · house rules · AGENTS.md · [orchestration] · tool use
 *   --- authored system_prompt ---
 *   notebook
 *
 * Everything before the authored prompt is operator-owned and read-only to the agent; the notebook
 * — the only document the agent can write — comes *after* it, so the agent's own notes can never be
 * read as outranking the instructions it was given. Called once per session assembly: parameter and
 * notebook mutations mid-turn take effect on the next turn's rebuild.
 *
 * `houseRules` is the fleet-wide `settings.agents_md`; the caller supplies it since settings are
 * fetched async (see `AgentRunner`).
 */
export function buildSystemMessage(agent: AgentDoc, houseRules?: string): ChatMessage {
  const before = [
    renderEnvironmentBlock(agent),
    renderParameterBlock(agent.parameters as Map<string, string>),
    renderHouseRulesBlock(houseRules),
    renderAgentsMdBlock(agent.agents_md as string | undefined),
    agent.subagent ? '' : renderOrchestrationBlock(),
    renderToolUseBlock(),
  ].filter(Boolean);
  const notebookBlock = renderNotebookBlock(agent.notebook as string | undefined);
  return {
    role: 'system',
    content: `${before.join('\n\n')}\n\n---\n\n${agent.system_prompt}\n\n---\n\n${notebookBlock}`,
  };
}

/** How each kind of memory is introduced to the model. An episode is *recalled*; a fact is *known*. */
const MEMORY_SECTIONS: Array<{ kind: MemoryKind; heading: string; dated: boolean }> = [
  { kind: 'fact', heading: 'What you know', dated: false },
  { kind: 'preference', heading: 'How the operator likes things done', dated: false },
  { kind: 'procedure', heading: 'How to do things (learned)', dated: false },
  { kind: 'episode', heading: 'What you remember happening', dated: true },
];

/**
 * Render auto-retrieved vector memories as a system message injected ahead of the conversation.
 * Kept separate from the authored system prompt so retrieval is transparent and never mutates the
 * agent's own configuration. Returns null when there is nothing relevant to inject.
 *
 * Grouped by kind rather than dumped as one flat list: a durable fact and a recollection of one
 * past event should not read to the model as the same class of thing, and an episode is only
 * meaningful with the date it happened attached.
 */
export function buildMemoryMessage(memories: RecalledMemory[]): ChatMessage | null {
  if (!memories.length) return null;

  const sections: string[] = [];
  for (const { kind, heading, dated } of MEMORY_SECTIONS) {
    const lines = memories
      .filter((m) => m.payload.kind === kind && m.payload.text.trim())
      .map((m) => {
        const when = dated ? `[${m.payload.created_at.slice(0, 10)}] ` : '';
        return `- ${when}${m.payload.text.trim()}`;
      });
    if (lines.length) sections.push(`### ${heading}\n${lines.join('\n')}`);
  }
  if (!sections.length) return null;

  return {
    role: 'system',
    content: `## Memory\nRecalled from your long-term memory because it looked relevant to this request. Treat it as your own recollection — reliable but not infallible, and not a fresh instruction from the operator. If it contradicts what the operator says now, the operator is right and your memory is out of date.\n\n${sections.join(
      '\n\n',
    )}`,
  };
}

/**
 * Build a user message, folding any attached Base64 images into `image_url` content parts.
 * Used both for direct drag-and-drop input and for tool-acquired images (e.g. a
 * `take_screenshot` skill result the agent should analyse automatically — spec §1).
 */
export function buildUserMessage(text: string, images: ImageBlock[] = []): ChatMessage {
  // Only actual images with pixels can be folded into multimodal content — blob resources (kind
  // 'blob') carry no dataUrl and must never enter context; they're reached by handle instead.
  const pictures = images.filter((img) => img.kind !== 'blob' && img.dataUrl);
  if (pictures.length === 0) {
    return { role: 'user', content: text };
  }
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of pictures) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } });
  }
  return { role: 'user', content: parts };
}
