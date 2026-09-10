import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { sessionRepository } from '../sessions/session.repository';
import { notificationRepository } from '../notifications/notification.repository';
import { forumPlanRepository } from './forum-plan.repository';
import { forumTaskRepository } from './forum-task.repository';
import { forumTaskRunner } from './forum-task-runner';
import { forumPlanService } from './forum-plan.service';
import type { ForumTaskDoc } from './forum-task.model';
import type { ForumPlanDoc } from './forum-plan.model';

const log = createLogger('forum-scheduler');

/**
 * The board's clock (spec `FORUM_WORKBOARD_PLAN.md` §5).
 *
 * **It never runs inference and never writes prose.** Everything it does is a state transition or a
 * dispatch. That is what makes the happy path free: a five-task project costs five work turns plus
 * five reviews and *zero* coordination turns, against the old design's one extra turn per hop plus
 * whatever acknowledgement chatter that turn triggered.
 *
 * It replaces `forum-sweeper.ts` entirely, and the difference is the whole plan in one line: the
 * sweeper existed to *guess* who should run next from mentions nobody had acted on. The plan says
 * who runs next, so there is nothing left to guess.
 */
export const forumScheduler = {
  async tick(): Promise<void> {
    const settings = await settingsService.get();
    if (!settings.forum_board_enabled) return;

    // 1. Reap first, always: a slot held by a finished run is a slot the ready set cannot use, and
    //    reaping is the only way a restart-interrupted dispatch ever comes back.
    const reaped = await reap(settings.forum_task_max_dispatches ?? 3);

    const inFlight = await forumTaskRepository.inFlight();
    const parallel = Math.max(1, settings.forum_max_parallel ?? 1);
    let slots = parallel - inFlight.length;
    if (slots <= 0) return;

    const plans = await forumPlanRepository.listRunning();
    const escalations: Array<{ plan: ForumPlanDoc; why: string }> = [];

    for (const plan of plans) {
      if (slots <= 0) break;
      const tasks = await forumTaskRepository.pending(plan._id);

      // A plan with nothing left pending is finished — announce it once and stop looking at it.
      if (!tasks.length) {
        await forumPlanRepository.update(plan._id, { state: 'done', finished_at: new Date() });
        await announceDone(plan);
        continue;
      }

      const ready = readySet(tasks);
      if (ready.length) {
        for (const task of ready) {
          if (slots <= 0) break;
          const kind = task.state === 'review' ? 'review' : 'work';
          const started = await forumTaskRunner.dispatch(String(task._id), kind);
          if (started) slots -= 1;
        }
        continue;
      }

      // Nothing ready and nothing running for this plan: it is stuck, and only the manager can
      // unstick it. Escalations are collected rather than run inline so one tick cannot spend the
      // whole parallel budget on planning turns while real work waits.
      const running = tasks.some((t) => t.state === 'doing' || Boolean(t.dispatch?.session_id));
      if (running) continue;
      escalations.push({ plan, why: describeStall(tasks) });
    }

    // Standalone tasks — filed outside any plan — share the same slots and the same rules, minus the
    // leash, because there is no project to spend one.
    if (slots > 0) {
      const loose = readySet(await forumTaskRepository.pendingStandalone());
      for (const task of loose) {
        if (slots <= 0) break;
        const started = await forumTaskRunner.dispatch(String(task._id), task.state === 'review' ? 'review' : 'work');
        if (started) slots -= 1;
      }
    }

    // At most one manager turn per tick, fleet-wide. A planning turn is the most expensive thing the
    // board can decide to do on its own, so it gets the strictest rate of anything here.
    const first = escalations[0];
    if (first) {
      await forumPlanRepository.update(first.plan._id, { state: 'blocked', escalation: first.why });
      await forumPlanService
        .runManager(String(first.plan._id), first.why)
        .catch((err) => log.error({ err: String(err), planId: String(first.plan._id) }, 'escalation failed'));
    }

    if (reaped || escalations.length) {
      log.info({ reaped, escalated: escalations.length, slots }, 'board tick');
    }
  },

  /** The operator's "plan this now" and "run this task now" both land here. */
  async dispatchNow(taskId: string, kind: 'work' | 'review'): Promise<{ sessionId: string } | null> {
    const started = await forumTaskRunner.dispatch(taskId, kind);
    return started ? { sessionId: started.sessionId } : null;
  },
};

/**
 * Tasks that can be dispatched right now.
 *
 * **Reviews outrank work, always** (spec §5.3). Work already done and waiting on a signature is the
 * cheapest thing on the board to turn into progress, and a review backlog is exactly what makes a
 * finished plan look like a stalled one.
 */
function readySet(tasks: ForumTaskDoc[]): ForumTaskDoc[] {
  const byId = new Map(tasks.map((t) => [String(t._id), t]));
  const done = (id: string): boolean => {
    const dep = byId.get(id);
    // A dependency outside this plan's pending set is one that is already finished (or cancelled) —
    // `pending` only returns unfinished tasks, so absence is the finished case.
    return !dep || dep.state === 'done' || dep.state === 'cancelled';
  };

  const reviews = tasks.filter((t) => t.state === 'review' && !t.dispatch?.session_id);
  const work = tasks.filter(
    (t) => t.state === 'todo' && !t.dispatch?.session_id && t.owner?.agent_id && t.depends_on.every((d) => done(String(d))),
  );
  return [...reviews, ...work];
}

/** Say what is actually wrong, so the manager's brief is a diagnosis rather than "something broke". */
function describeStall(tasks: ForumTaskDoc[]): string {
  const blocked = tasks.filter((t) => t.state === 'blocked');
  if (blocked.length) {
    return `${blocked.length} task(s) blocked: ${blocked
      .map((t) => `"${t.goal}" — ${t.blocked_on || 'no reason given'}`)
      .join('; ')}`;
  }
  const unowned = tasks.filter((t) => t.state === 'todo' && !t.owner?.agent_id);
  if (unowned.length) {
    return `${unowned.length} task(s) have no owner: ${unowned.map((t) => `"${t.goal}"`).join('; ')}`;
  }
  const waiting = tasks.filter((t) => t.state === 'todo');
  if (waiting.length) {
    return `${waiting.length} task(s) are waiting on dependencies that will never finish — the graph has a gap`;
  }
  return 'the plan has pending tasks but none of them can run';
}

/**
 * Reap dispatches whose session has finished.
 *
 * The in-flight marker lives on the task rather than in a process-local set precisely so this works
 * across a restart: the mention queue lost its state on every deploy and the old spec called that
 * "the honest failure mode for a convenience", which it is not for a project half-way through.
 *
 * A dispatch that came back with nothing counts against `forum_task_max_dispatches`, and past it the
 * task is blocked for the manager. Without that, a task no agent can actually do is re-dispatched
 * every tick until the plan's whole allowance is gone.
 */
async function reap(maxDispatches: number): Promise<number> {
  const running = await forumTaskRepository.inFlight();
  let reaped = 0;
  for (const task of running) {
    const sessionId = String(task.dispatch?.session_id ?? '');
    if (!sessionId) continue;
    const session = await sessionRepository.findById(sessionId);
    // The session is gone, or its turn is over and the agent moved the task itself (in which case
    // `submit`/`block`/`review` already cleared the claim and this loop never sees it).
    const finished = !session || (Array.isArray(session.messages) ? session.messages.length : 0) >= 2;
    if (!finished) continue;

    const spent = task.dispatch?.count ?? 0;
    if (spent >= Math.max(1, maxDispatches)) {
      await forumTaskRepository.releaseDispatch(String(task._id), 'blocked');
      await forumTaskRepository.update(task._id, {
        blocked_on:
          task.blocked_on ||
          `dispatched ${spent}× and came back without a submission — it may not be doable as written`,
      });
      log.warn({ taskId: String(task._id), spent }, 'task blocked after repeated empty dispatches');
    } else {
      await forumTaskRepository.releaseDispatch(String(task._id), 'todo');
      log.info({ taskId: String(task._id), spent }, 'dispatch ended without a submission — requeued');
    }
    reaped += 1;
  }
  return reaped;
}

/**
 * Tell the operator a project finished.
 *
 * The counterpart of `FORUM_AUTORUN_PLAN.md`'s exhaustion alert, and for the same reason: without
 * it, the end of a project is a log line in a container nobody is tailing, and a finished project
 * looks exactly like a stalled one from outside.
 */
async function announceDone(plan: ForumPlanDoc): Promise<void> {
  const tasks = await forumTaskRepository.listByPlan(plan._id);
  const done = tasks.filter((t) => t.state === 'done').length;
  await notificationRepository
    .create({
      title: `Project finished: ${plan.goal}`,
      content:
        `${done} of ${tasks.length} tasks accepted, ${plan.turns_spent} agent turns spent of ` +
        `${plan.turns_max}. Every deliverable is on its task's thread.`,
      kind: 'forum_thread',
      ref_id: String(plan.hub_thread_id),
    })
    .catch((err) => log.error({ err: String(err), planId: String(plan._id) }, 'project completion alert failed'));
  log.info({ planId: String(plan._id), done, of: tasks.length }, 'project finished');
}
