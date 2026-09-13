import { buildBoardBlock, buildForumBlock } from '../../domain/forum/forum-recall.service';
import type {
  AutoLoopPromptState,
  PromptContext,
  PromptModule,
  SubagentsPromptState,
  TaskPromptState,
} from '../types';

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

export const orchestrationModule: PromptModule = {
  id: 'orchestration',
  name: 'Orchestration',
  description: 'Top-level agents survey the fleet and delegate, instead of answering everything alone.',
  group: 'work',
  // A subagent does one narrow job and hands back a report: it is never told to route work, and
  // holds none of the delegation tools.
  subagentDefault: false,
  tools: ['annuaire', 'ask_agent', 'ask_parent'],
  blocks: [
    {
      title: 'Orchestration',
      placement: 'system_head',
      order: 50,
      overridable: true,
      // Subagents keep their own scope; only a top-level agent is told to route work — and never a
      // `task` child, which holds no delegation tool even when its agent is top-level.
      render: (ctx: PromptContext) => (ctx.agent.subagent || ctx.task ? null : renderOrchestrationBlock()),
    },
  ],
};

/**
 * The board: work items dispatched to this agent, and submitted work awaiting its verdict.
 *
 * **Ships off**, exactly as `forum_board_enabled` shipped — turning a board where agents address
 * each other into a self-driving one is a decision, not a default. The module switch *is* that
 * setting: toggling the row writes `settings.forum_board_enabled`, which is what
 * `forum-scheduler.ts` still reads.
 */
export const boardModule: PromptModule = {
  id: 'board',
  name: 'Work board',
  description: 'Dispatched tasks and reviews, and the scheduler that hands them out.',
  group: 'work',
  defaultEnabled: false,
  // A subagent does one narrow job and hands back a report: the board's dispatched work belongs to
  // the agent's own turns, not to a brief it was handed.
  subagentDefault: false,
  tools: ['board'],
  settingsKeys: [
    'forum_board_enabled',
    'forum_tick_interval_minutes',
    'forum_max_parallel',
    'forum_subagent_endpoint_id',
    'forum_subagent_model',
    'forum_task_max_dispatches',
    'forum_task_max_review_rounds',
    'forum_plan_max_turns',
    'forum_plan_max_revisions',
    'forum_project_manager_agent',
  ],
  blocks: [
    {
      title: 'Board',
      placement: 'system_tail',
      order: 140,
      render: (ctx: PromptContext) => (ctx.board ? buildBoardBlock(ctx.board) : null),
    },
  ],
};

export const forumModule: PromptModule = {
  id: 'forum',
  name: 'Forum',
  description: 'Passive thread pointers, mentions and the fleet roster — plus the forum tools.',
  group: 'work',
  // A subagent does one narrow job and hands back a report: thread pointers and mentions are the
  // agent's standing business, and answering one is not what the brief asked for.
  subagentDefault: false,
  tools: ['forum', 'forum_admin'],
  settingsKeys: [
    'forum_auto_reply',
    'forum_auto_reply_max_per_thread',
    'forum_auto_reply_window_hours',
    'forum_auto_reply_max_per_project',
    'forum_post_contract_enabled',
  ],
  blocks: [
    {
      title: 'Forum',
      placement: 'system_tail',
      order: 145,
      render: (ctx: PromptContext) => (ctx.forum ? buildForumBlock(ctx.forum) : null),
    },
  ],
};

export const autoLoopModule: PromptModule = {
  id: 'auto-loop',
  name: 'Auto loop',
  description: 'The standing goal and progress log of a self-driving conversation.',
  group: 'work',
  // A subagent does one narrow job and hands back a report: only the loop's own turns may end the
  // loop, and a child is not one of them.
  subagentDefault: false,
  tools: ['loop_done'],
  blocks: [
    {
      title: 'Auto loop',
      placement: 'system_tail',
      // Right after the task list: the checklist is how the agent works, the goal is what it is
      // working toward — and both precede what memory and the board hand it.
      order: 125,
      render: (ctx: PromptContext) => (ctx.autoLoop ? renderAutoLoopBlock(ctx.autoLoop) : null),
    },
  ],
};

/**
 * Parent guidance: when to hand work to a `task` subagent, and how (`SUBAGENT_PLAN.md` §3).
 *
 * Three habits make subagents worth their cost, and each is a way they fail without being told:
 *
 *  - **The brief has to stand alone.** The child sees nothing of this conversation, and "check the
 *    thing we discussed" produces a confident report about the wrong thing.
 *  - **Delegate the reading, keep the judgement.** The point is that raw material never enters the
 *    parent's context; a decision made by a child the parent cannot see is a decision nobody checked.
 *  - **Issue independent tasks together.** Parallelism only happens inside one batch of calls.
 *
 * The concurrency sentence is written from the live endpoint slots rather than assumed, so the block
 * never promises simultaneous work on a box that serves one stream.
 */
export function renderSubagentsBlock(s: SubagentsPromptState): string {
  const width = s.parallel && s.slots > 1
    ? `Up to ${s.slots} \`explore\` tasks run at the same time, so a batch of them costs about as long as its slowest one.`
    : 'Tasks run one after another here, but issuing independent ones together still saves you a round of thinking per task.';
  const model = s.differentModel
    ? ` Subagents run on \`${s.model}\`, which may be smaller than you: give them narrow, concrete briefs and check what they report before you rely on it.`
    : '';
  return (
    '## Subagents\n' +
    'You can hand a self-contained piece of your own work to a subagent with `task` — a fresh copy of ' +
    'you with an empty context — and receive only its report. Use it for broad, read-heavy work whose ' +
    'answer is short: surveying many files, researching several sources, digging through logs. The ' +
    'raw material then stays out of your context. Do small or quick work yourself, and never delegate ' +
    'something that depends on this conversation without writing that context into the brief.\n' +
    '- **The brief must stand alone.** The subagent sees nothing of this conversation. Put in every ' +
    'fact, path and constraint it needs, what is out of scope, and exactly what the report must contain.\n' +
    '- **`explore`** is read-only (reading, searching, fetching). **`work`** may change things and ' +
    'always runs alone. Prefer `explore`, and keep decisions and edits for yourself.\n' +
    `- **Issue independent tasks in one reply.** ${width}\n` +
    '- **Verify before acting.** Reports cite evidence (paths, lines, URLs, quotes); spot-check the ' +
    `claims your next step depends on.${model}`
  );
}

/**
 * The child contract: what a `task` subagent is, and what its answer must look like.
 *
 * It is told nobody can answer it, because a child that asks a clarifying question and stops has
 * spent a whole run producing nothing; told its report size, because a report cut mid-finding loses
 * the finding; and told to cite evidence, because its parent never saw the source and can only check
 * a claim that says where it came from.
 */
export function renderTaskBlock(t: TaskPromptState): string {
  const mode =
    t.mode === 'explore'
      ? 'This is an **explore** task: you are read-only. Read, search and fetch — never create, edit, ' +
        'delete, post or run anything that changes state. A tool that would is refused.'
      : 'This is a **work** task: you may change things, but only what the brief asks for.';
  return (
    '## Subagent task\n' +
    `You are running as a subagent for your own parent run (${t.parentName}), on one task: ` +
    `"${t.description}". The user message is your complete brief; you have no other context.\n` +
    `${mode}\n` +
    'Nobody can answer questions while you work. If something is ambiguous, make the most reasonable ' +
    'assumption, say so in the report, and carry on. If you are blocked, stop and report what blocked you.\n' +
    `When you are done, reply with a report of at most ~${t.reportMaxChars} characters — anything ` +
    'longer is cut off:\n' +
    '1. **Findings** — the answer to the brief. Each finding cites its evidence: `path:line`, a URL, ' +
    'or a short exact quote.\n' +
    '2. **Open issues** — what you could not establish, and what you assumed.\n' +
    'Report facts, not a narrative of what you did.'
  );
}

/**
 * Subagents: the `task` tool, the guidance a parent gets, and the contract a child gets. One switch
 * removes all three. Whether calls overlap at all, and how many, stays Settings → Fleet
 * (`tool_parallel_*`) and each endpoint's Parallel streams — properties of this backend, not of the
 * prompt — and the model the children run on is the fleet default or the agent's own override.
 */
export const subagentsModule: PromptModule = {
  id: 'subagents',
  name: 'Subagents',
  description: 'Agents hand read-heavy work to fresh-context copies of themselves, several at once.',
  group: 'work',
  tools: ['task'],
  settingsKeys: [
    'subagent_endpoint_id',
    'subagent_model',
    'subagent_report_max_chars',
    'tool_parallel_enabled',
    'tool_parallel_max',
  ],
  blocks: [
    {
      title: 'Subagent task',
      placement: 'system_head',
      // Right after Environment: before anything else, the child has to know what kind of run it is.
      order: 15,
      render: (ctx: PromptContext) => (ctx.task ? renderTaskBlock(ctx.task) : null),
    },
    {
      title: 'Subagents',
      placement: 'system_head',
      // Next to Orchestration — both are about handing work to someone else.
      order: 55,
      render: (ctx: PromptContext) => (!ctx.task && ctx.subagents ? renderSubagentsBlock(ctx.subagents) : null),
    },
  ],
};
