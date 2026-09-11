import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';
import { sessionLock } from '../../core/session/SessionLock';
import { agentRunner, RunAbortedError } from '../../orchestrator/AgentRunner';
import { liveRuns } from '../../transport/ws/live-runs';
import { TurnRecorder } from '../../transport/ws/TurnRecorder';
import { agentRepository } from '../agents/agent.repository';
import { sessionRepository } from '../sessions/session.repository';
import { settingsService } from '../settings/settings.service';
import { forumTaskRepository } from './forum-task.repository';
import { forumPlanRepository } from './forum-plan.repository';
import { forumTaskService } from './forum-task.service';
import type { ForumTaskDoc } from './forum-task.model';
import type { ForumPlanDoc } from './forum-plan.model';

const log = createLogger('forum-task-run');

/** How long a dispatch waits for a live operator chat on the same agent before giving up its slot. */
const YIELD_TIMEOUT_MS = 60_000;

export type DispatchKind = 'work' | 'review';

/** A run pointed at a model that is not the agent's own, or `null` for "run as configured". */
type SubagentTarget = { endpointId?: string | null; model?: string } | null;

/**
 * Subagent mode (`BOARD_SUBAGENT_MODEL_PLAN.md` §4): which model this dispatch runs on.
 *
 * `work` only. A review is the cheap turn in tokens and the expensive one in consequences — a
 * reviewer that rubber-stamps feeds a wrong deliverable into every task that depends on it — so it
 * keeps the model its agent was configured with, as does the manager's planning turn.
 *
 * The project's own setting wins over the fleet's, field by field: a plan may move its work onto a
 * bigger model while inheriting the fleet's endpoint. Both empty everywhere = no override, and
 * `resolveInference` falls through to the agent exactly as it always did.
 */
async function subagentTarget(kind: DispatchKind, plan: ForumPlanDoc | null): Promise<SubagentTarget> {
  if (kind !== 'work') return null;
  const settings = await settingsService.get();
  const endpointId = (plan?.subagent_endpoint_id || settings.forum_subagent_endpoint_id || '').trim();
  const model = (plan?.subagent_model || settings.forum_subagent_model || '').trim();
  if (!endpointId && !model) return null;
  return { endpointId: endpointId || null, model: model || undefined };
}

/**
 * The dispatch brief (spec `FORUM_WORKBOARD_PLAN.md` §6).
 *
 * Three things it deliberately does **not** say, each removed because the old mention brief said it
 * and each one produced a class of post nobody read:
 *
 * - it never asks the agent to wake anybody (the scheduler dispatches, so there is nothing to route);
 * - it never asks for an acknowledgement;
 * - it does not require a post at all. **Silence is a legal outcome.** A turn that submits a
 *   deliverable without a word of prose is the best possible outcome, not a deficient one — which
 *   is the exact inversion of the old `drive`, where an agent that posted nothing had its closing
 *   narration posted for it.
 */
function workBrief(task: ForumTaskDoc, plan: ForumPlanDoc | null, deps: ForumTaskDoc[], discussion: string[]): string {
  const lines = [
    `**Task \`${String(task._id)}\`** — ${task.goal}`,
    '',
  ];
  if (plan) lines.push(`Part of the project: *${plan.goal}*`, '');
  lines.push('**Done when:**', ...task.acceptance.map((a) => `- ${a}`), '');

  const finished = deps.filter((d) => d.state === 'done');
  if (finished.length) {
    lines.push(
      'Work this builds on, already finished and accepted:',
      ...finished.map(
        (d) =>
          `- ${d.goal} → ${d.deliverable ? `${d.deliverable.kind} \`${d.deliverable.ref}\`` : 'no deliverable recorded'}` +
          `${d.deliverable?.note ? ` (${d.deliverable.note})` : ''}`,
      ),
      '',
    );
  }
  if (task.blocked_on) {
    lines.push(`This came back to you: ${task.blocked_on}`, '');
  }
  if (task.review_rounds > 0) {
    lines.push(
      `A reviewer has sent this back ${task.review_rounds}× already — read the thread for what they ` +
        'said before redoing it the same way.',
      '',
    );
  }
  if (discussion.length) {
    lines.push('Recent discussion on its thread:', ...discussion.map((d) => `> ${d}`), '');
  }

  lines.push(
    `Discussion thread: \`${String(task.thread_id)}\` — \`forum\` \`read_thread\` for the rest of it.`,
    '',
    '**Do the work, then end your turn one of two ways:**',
    '',
    '- `board` `submit` — `task_id`, and a `deliverable` (`kind` one of `attachment` / `handle` / ' +
      '`post` / `external`, plus the `ref` that points at it). That *is* your report; a reviewer ' +
      'reads it next.',
    '- `board` `block` — `task_id` and one line saying what you are waiting on, if you genuinely ' +
      'cannot finish.',
    '',
    'Nothing else is required of you. Do not post a summary of your submission, do not announce that ' +
      'you are starting, and do not name anybody to pick this up — the board dispatches the next ' +
      'step by itself the moment this one is accepted.',
  );
  return lines.join('\n');
}

/**
 * The review brief.
 *
 * It carries the acceptance criteria *and* the deliverable, because a reviewer judging against a
 * remembered standard fails work for being different rather than for being wrong — and on this board
 * a failed review costs the owner another full turn.
 */
function reviewBrief(task: ForumTaskDoc, plan: ForumPlanDoc | null, discussion: string[]): string {
  const d = task.deliverable;
  return [
    `**Review task \`${String(task._id)}\`** — ${task.goal}`,
    plan ? `Part of the project: *${plan.goal}*` : '',
    '',
    `Submitted by **${d?.submitted_by || task.owner?.display_name || 'unknown'}**:`,
    `- ${d?.kind ?? 'none'} \`${d?.ref ?? ''}\`${d?.note ? ` — ${d.note}` : ''}`,
    '',
    'Judge it against these, and only these:',
    ...task.acceptance.map((a) => `- ${a}`),
    '',
    discussion.length ? 'Recent discussion on its thread:' : '',
    ...discussion.map((x) => `> ${x}`),
    '',
    `Open the deliverable before deciding — \`forum\` \`get_attachment\` for a file id, \`read_thread\` ` +
      `on \`${String(task.thread_id)}\` for the discussion, your ordinary tools for a path or a URL.`,
    '',
    '**End your turn with `board` `review`:** `task_id`, `verdict` `"pass"` or `"fail"`, and on a ' +
      'fail, `reasons` saying exactly what is missing. The owner is dispatched again from your ' +
      'reasons alone, so a vague fail buys another turn of the same work.',
    '',
    'Pass it if it meets the criteria. "Not how I would have done it" is not a fail; a criterion ' +
      'that is not met is.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export const forumTaskRunner = {
  /**
   * Dispatch one task to one agent, as an ordinary session the operator can open, watch and stop.
   *
   * Reuses everything `forum-mention-runner.ts` established: an `origin: 'forum'` session in the
   * Chat page, a `TurnRecorder` off the EventBus so a turn nobody is watching is still persisted,
   * `SessionLock` yielding to a live operator chat, and `liveRuns` so the stop button works. The
   * only thing that differs is what the agent is told and what ends the turn.
   *
   * The claim is taken *before* the session exists and released in `finally`, so a crashed run
   * leaves a task the next tick can reap rather than one stuck in flight forever.
   */
  async dispatch(taskId: string, kind: DispatchKind): Promise<{ sessionId: string; done: Promise<void> } | null> {
    const task = await forumTaskRepository.findById(taskId);
    if (!task) return null;

    const actor = kind === 'review' ? await forumTaskService.reviewerFor(task) : task.owner;
    if (!actor || actor.kind !== 'agent' || !actor.agent_id) {
      log.info({ taskId, kind }, 'nothing to dispatch to — the operator holds this one');
      return null;
    }
    const agent = await agentRepository.findById(actor.agent_id);
    if (!agent) {
      log.warn({ taskId, agent: actor.display_name }, 'dispatch target no longer exists');
      return null;
    }

    const plan = task.plan_id ? await forumPlanRepository.findById(task.plan_id) : null;
    // The leash, claimed before the turn for the reason the mention budget was: a run that dies on
    // an unreachable endpoint still spends its unit, or a failing task retries forever.
    if (plan) {
      const spent = await forumPlanRepository.claimTurn(plan._id);
      if (spent === null) {
        log.warn({ plan: plan.goal, turnsMax: plan.turns_max }, 'plan is out of turns — not dispatching');
        await forumPlanRepository.update(plan._id, {
          state: 'blocked',
          escalation: `out of turns (${plan.turns_max} spent)`,
        });
        return null;
      }
    }

    const session = await sessionRepository.create({
      agentId: agent._id,
      agentName: agent.name,
      title: kind === 'review' ? `Review: ${task.goal}` : task.goal,
      origin: 'forum',
      forumThreadId: task.thread_id,
    });
    const sessionId = String(session._id);

    // Atomic: two ticks, or a tick racing the operator's manual dispatch, cannot both start a turn.
    const claimed = await forumTaskRepository.claimDispatch(
      task._id,
      session._id as Types.ObjectId,
      kind,
      kind === 'review' ? 'review' : 'doing',
    );
    if (!claimed) {
      log.info({ taskId }, 'task was claimed by another dispatch — standing down');
      return null;
    }

    eventBus.emit('conversation:session_created', {
      sessionId,
      agentId: String(agent._id),
      agentName: agent.name,
      title: session.title,
      origin: 'forum',
    });

    const deps = await forumTaskRepository.findMany(claimed.depends_on);
    const discussion = await forumTaskService.recentDiscussion(claimed.thread_id).catch(() => []);
    const text =
      kind === 'review' ? reviewBrief(claimed, plan, discussion) : workBrief(claimed, plan, deps, discussion);
    const inference = await subagentTarget(kind, plan);
    if (inference) {
      log.info({ taskId, agent: agent.name, ...inference }, 'work turn runs on the subagent model');
    }

    const done = this.drive(sessionId, agent.name, String(agent._id), text, inference)
      .catch((err) => log.error({ err: String(err), taskId }, 'task dispatch failed'))
      .finally(async () => {
        // Whatever happened, the claim goes. The state itself was moved by `submit` / `block` /
        // `review` if the agent used them — in which case the claim is already gone and there is
        // nothing here to release. If it did not, this dispatch was spent for nothing and counts
        // against the leash, exactly as the reaper counts one it had to recover.
        const after = await forumTaskRepository.findById(taskId);
        if (after && String(after.dispatch?.session_id ?? '') === sessionId) {
          const settings = await settingsService.get();
          await forumTaskService.releaseEmptyDispatch(taskId, settings.forum_task_max_dispatches ?? 3);
        }
      });

    log.info({ taskId, kind, agent: agent.name, sessionId }, 'task dispatched');
    return { sessionId, done };
  },

  /**
   * Run one turn. Lifted from `forum-mention-runner.drive` with the post-back removed — a task's
   * record is its submission, not its prose, so there is nothing to fall back to posting.
   *
   * `inference` redirects this one turn onto another endpoint/model. It is a parameter rather than
   * something resolved in here because `forumPlanService.runManager` shares this method: the manager
   * passes nothing and so keeps its own model, which is exactly the split subagent mode is.
   */
  async drive(
    sessionId: string,
    agentName: string,
    agentId: string,
    text: string,
    inference: SubagentTarget = null,
  ): Promise<void> {
    const ctx: EventContext = { sessionId, agentId, agentName, depth: 0 };
    await sessionRepository.addMessage(sessionId, { role: 'user', text });
    eventBus.emit('chat:user_message', { ctx, content: text });

    const recorder = new TurnRecorder(sessionId, agentName);
    recorder.start();
    const controller = new AbortController();
    liveRuns.start(sessionId, recorder, controller);

    // A live operator chat on this agent wins — the board can wait a minute.
    await sessionLock.waitUntilFree(agentId, YIELD_TIMEOUT_MS);

    try {
      const result = await agentRunner.run({
        agentName,
        sessionId,
        depth: 0,
        userText: text,
        signal: controller.signal,
        inference,
      });
      const turn = recorder.build(result.text);
      await sessionRepository.addMessage(sessionId, {
        role: 'assistant',
        text: result.text,
        blocks: turn.blocks,
        reasoning: turn.reasoning || undefined,
        trace: turn.trace,
        memories: turn.memories,
        context_tokens: turn.contextTokens,
        context_window: turn.contextWindow,
        turn_id: result.turnId,
        run_id: result.runId,
      });
      eventBus.emit('conversation:turn_complete', {
        ctx,
        answer: result.text,
        blocks: turn.blocks,
        memories: turn.memories,
        turnId: result.turnId,
        runId: result.runId,
      });
    } catch (err) {
      const stopped = err instanceof RunAbortedError || controller.signal.aborted;
      const failure = err instanceof Error ? err.message : String(err);
      const turn = recorder.build('');
      const blocks = stopped
        ? turn.blocks
        : [...turn.blocks, { kind: 'text' as const, text: `\n\n⚠️ The run failed: ${failure}` }];
      await sessionRepository
        .addMessage(sessionId, { role: 'assistant', text: '', blocks, trace: turn.trace })
        .catch((e) => log.error({ err: String(e) }, 'failed to persist interrupted task turn'));
      eventBus.emit('conversation:turn_complete', { ctx, answer: '', blocks, turnId: '', runId: '' });
    } finally {
      recorder.stop();
      liveRuns.end(sessionId);
    }
  },
};
