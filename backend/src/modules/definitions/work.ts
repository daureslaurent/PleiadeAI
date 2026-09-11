import { buildBoardBlock, buildForumBlock } from '../../domain/forum/forum-recall.service';
import type { AutoLoopPromptState, PromptContext, PromptModule } from '../types';

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
  tools: ['annuaire', 'ask_agent', 'ask_parent'],
  blocks: [
    {
      title: 'Orchestration',
      placement: 'system_head',
      order: 50,
      overridable: true,
      // Subagents keep their own scope; only a top-level agent is told to route work.
      render: (ctx: PromptContext) => (ctx.agent.subagent ? null : renderOrchestrationBlock()),
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
