import type { AgentDoc } from './agent.model';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { MemoryKind, RecalledMemory } from '../memory/memory.types';
import type { TodoItem } from '../todos/todo.repository';

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

const TODO_STATUS_MARK: Record<string, string> = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
};

/**
 * Render the agent's working checklist (`todowrite`) plus how to use it.
 *
 * This block is the mechanism behind "don't lose a step mid-flight". The list is session-scoped and
 * survives turn boundaries, so an agent that ended a turn with an item still `in_progress` opens the
 * next one looking at exactly that — no separate `todoread` tool and no end-of-turn interrogation
 * needed, because the state is simply always in front of it.
 *
 * Injected after the notebook: it is the agent's own working state, not instruction.
 */
export function renderTodoBlock(items: TodoItem[] = []): string {
  const usage =
    'Use `todowrite` for multi-step work (~3+ steps) so you do not drop a step: write the plan ' +
    'before you start, keep exactly one item `in_progress`, and mark each done as you finish it — ' +
    'not in a batch at the end. Send the complete list on every call; it replaces the previous one. ' +
    'Skip it for simple one-shot requests.';

  if (!items.length) return `## Task list\n_(empty.)_ ${usage}`;

  const lines = items.map((it) => `${TODO_STATUS_MARK[it.status] ?? '[ ]'} ${it.content}`).join('\n');
  const unfinished = items.filter((it) => it.status !== 'completed').length;
  // Name the leftover explicitly rather than trusting the model to diff the marks itself — an
  // unfinished item is precisely what a turn boundary tends to bury.
  const carry = unfinished
    ? `\n\n${unfinished} item(s) still open. Continue from the first one that is not \`[x]\`, and update the list as you go.`
    : '\n\nAll items are complete. Start a fresh list if new multi-step work comes up.';

  return `## Task list\nYour current plan for this session, written by you.\n\n${lines}${carry}\n\n${usage}`;
}

/** What the auto-loop block needs to know about the running loop (see `AUTO_AGENT_PLAN.md`). */
export interface AutoLoopPromptState {
  goal: string;
  /** The iteration about to run (1-based). */
  iteration: number;
  intervalSec: number;
  progress: { n: number; summary: string }[];
}

/**
 * Render the standing goal of a self-driving conversation, plus what the agent has already done
 * toward it (`AUTO_AGENT_PLAN.md` §4). Injected on every iteration of an auto loop, and absent
 * entirely from an ordinary chat.
 *
 * Three things make this block earn its tokens, and each is a failure mode seen in ordinary
 * long-running agent loops:
 *
 *  - **The goal is repeated every turn.** A loop runs for hours and its history gets truncated; a
 *    goal stated once in turn 1 is a goal the agent has quietly stopped working on by turn 40.
 *  - **Progress is fed back explicitly.** Without it the agent re-does its first move forever,
 *    because each turn's continue message looks identical to the last one.
 *  - **It says nobody may be watching.** An agent that thinks it is in a chat asks a clarifying
 *    question and stops. Here that question would hang until the interval expires and then be
 *    asked again, so the instruction is to decide and act, and to say what it assumed.
 */
export function renderAutoLoopBlock(loop: AutoLoopPromptState): string {
  const lines = [
    '## Auto loop',
    '',
    `You are running unattended, on your own, in a loop: iteration ${loop.iteration}, one turn roughly every ${loop.intervalSec}s.`,
    'The operator may not be at the keyboard. Do not ask a clarifying question and wait — decide,',
    'act, and state the assumption you made. Do not just describe what you would do: use your tools',
    'and actually do it this turn.',
  ];

  if (loop.goal.trim()) {
    lines.push('', '### Your goal', loop.goal.trim());
  }

  if (loop.progress.length) {
    lines.push(
      '',
      '### What you have done so far',
      ...loop.progress.map((p) => `- Iteration ${p.n}: ${p.summary}`),
      '',
      'Do not repeat finished work. Pick up from where that leaves off and make one concrete step of',
      'progress this turn.',
    );
  } else {
    lines.push('', 'This is your first turn on this goal. Start by working out what it actually requires.');
  }

  lines.push(
    '',
    'When the goal is genuinely met — not "I made progress", but *done* — call `loop_done` with a',
    'short summary and the loop ends. Nothing else stops it: if you finish and do not call it, you',
    'will simply be asked to continue again, so do not claim completion in prose and leave the loop',
    'running. Equally, do not call it to escape a hard turn.',
  );

  return lines.join('\n');
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
 * Render the conversation's active `prompt` modes (`MODES_PLAN.md`) as a stamped, operator-owned
 * block. The stamp is the whole point: appended raw, the text landed after the notebook and read as
 * more of the agent's own notes — and the notebook is deliberately the *lowest*-authority document in
 * this prompt. Naming the operator as its author, and saying plainly what it outranks, is what turns
 * "some text at the end" into an instruction the model treats as binding.
 *
 * Placed last so it also has recency; that costs nothing here, since the environment block's
 * minute-resolution clock already changes the prompt prefix on every turn.
 */
export function renderActiveModesBlock(texts: string[]): string {
  if (!texts.length) return '';
  const rules = texts.map((t) => `- ${t.trim()}`).join('\n');
  return (
    '## Active modes\n' +
    'The operator switched these on for this conversation. They are binding for this turn and ' +
    'outrank your notebook, your task list, and anything earlier in this prompt that conflicts with ' +
    'them. Follow them exactly; if one makes the request impossible, say so rather than quietly ' +
    `dropping it.\n\n${rules}`
  );
}

/**
 * The same modes stamped onto the *end of the user turn* — the placement llama.cpp chat-template
 * control tokens (`/no_think`) require, and the strongest position for an instruction the model must
 * not drift away from mid-answer. Kept terse: this rides on every turn of the conversation.
 */
export function renderModeUserSuffix(texts: string[]): string {
  if (!texts.length) return '';
  const rules = texts.map((t) => t.trim()).join('\n');
  return `[Active modes — set by the operator for this conversation, follow exactly:\n${rules}]`;
}

/**
 * Compose the JIT system prompt. Ordering is deliberate and encodes who owns what:
 *
 *   environment · parameters · house rules · AGENTS.md · [orchestration] · tool use
 *   --- authored system_prompt ---
 *   notebook · task list
 *
 * Everything before the authored prompt is operator-owned and read-only to the agent; the notebook
 * — the only document the agent can write — comes *after* it, so the agent's own notes can never be
 * read as outranking the instructions it was given. Called once per session assembly: parameter and
 * notebook mutations mid-turn take effect on the next turn's rebuild.
 *
 * `houseRules` is the fleet-wide `settings.agents_md`; the caller supplies it since settings are
 * fetched async (see `AgentRunner`).
 */
export function buildSystemMessage(
  agent: AgentDoc,
  houseRules?: string,
  todos: TodoItem[] = [],
  autoLoop: AutoLoopPromptState | null = null,
): ChatMessage {
  const before = [
    renderEnvironmentBlock(agent),
    renderParameterBlock(agent.parameters as Map<string, string>),
    renderHouseRulesBlock(houseRules),
    renderAgentsMdBlock(agent.agents_md as string | undefined),
    agent.subagent ? '' : renderOrchestrationBlock(),
    renderToolUseBlock(),
  ].filter(Boolean);
  const after = [
    renderNotebookBlock(agent.notebook as string | undefined),
    renderTodoBlock(todos),
    // The loop's standing goal, when this conversation is a self-driving one. Placed after the task
    // list — the checklist is how the agent works, the goal is what it is working toward.
    ...(autoLoop ? [renderAutoLoopBlock(autoLoop)] : []),
  ].join('\n\n');
  return {
    role: 'system',
    content: `${before.join('\n\n')}\n\n---\n\n${agent.system_prompt}\n\n---\n\n${after}`,
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
