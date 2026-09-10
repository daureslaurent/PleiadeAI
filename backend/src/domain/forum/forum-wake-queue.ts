import type { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { notificationRepository } from '../notifications/notification.repository';
import { settingsService } from '../settings/settings.service';
import { forumMentionRepository } from './forum-mention.repository';
import { forumMentionRunner } from './forum-mention-runner';
import { autoRunWindowMs, budgetTargetFor, forumThreadRepository } from './forum-thread.repository';

const log = createLogger('forum-wake');

/**
 * The one path from "somebody was woken" to "somebody runs".
 *
 * This is the replacement for `forum-auto-reply.ts`, and the difference is what is *missing*. That
 * module carried six brakes — a pair cap, a chain ceiling, a back-summon rule, a per-thread budget,
 * a novelty guard and a sweeper — because waking was implicit: any `@name` might mean "go and do
 * something", so the guards had to guess which ones did. Waking is now stated, in a structured
 * `wake` argument the agent has to fill in, so there is nothing left to guess and only one brake
 * worth keeping: the budget, which stops a pair that has genuinely started paging each other in
 * circles from doing it all night.
 *
 * The order matters and is why this is a queue rather than a fan-out: "wake architect, then
 * developer" is a sequence, and the second agent has to see the first one's *posted* reply, which
 * only exists once that run has finished.
 *
 * In memory rather than a collection. A restart mid-queue leaves the mentions `pending`, which is
 * exactly the state the operator's Run button expects — nothing is lost, it just stops being
 * automatic, which is the honest failure mode for a convenience.
 */
interface Queued {
  mentionId: string;
  threadId: string;
  threadTitle: string;
  agentName: string;
  authorName: string;
}

const queue: Queued[] = [];
let draining = false;

export const forumWakeQueue = {
  /**
   * Take a post's woken mentions, in the order they were written.
   *
   * Only the fleet switch is checked here. Everything that can change while a mention waits its turn
   * — the switch itself, the thread being locked, the budget, the operator answering it by hand — is
   * re-checked at the moment it runs, because a queue drains slowly by design.
   */
  async enqueue(rows: Queued[]): Promise<void> {
    if (!rows.length) return;
    const settings = await settingsService.get();
    if (!settings.forum_auto_reply) {
      log.info({ woken: rows.map((r) => r.agentName) }, 'wake requested but auto-reply is off — left pending');
      return;
    }
    queue.push(...rows);
    log.info({ woken: rows.map((r) => r.agentName), depth: queue.length }, 'agents woken by a post');
    void drain();
  },

  /** True while anything is queued or running. */
  isBusy(): boolean {
    return draining || queue.length > 0;
  },
};

/** Drain strictly one run at a time. A re-entrant call returns — the running loop takes what it pushed. */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await runOne(next).catch((err) =>
        log.error({ err: String(err), mentionId: next?.mentionId }, 'wake run failed'),
      );
    }
  } finally {
    draining = false;
  }
}

/**
 * Run one woken mention, if it still deserves it.
 *
 * Every reason to decline leaves the mention `pending` rather than dismissed: the operator's Run
 * button is the fallback for all of them, and silently marking a mention answered when nothing
 * answered it is the one outcome nobody could debug.
 */
async function runOne(item: Queued): Promise<void> {
  const settings = await settingsService.get();
  if (!settings.forum_auto_reply) return;

  const mention = await forumMentionRepository.findById(item.mentionId);
  // Already answered (the operator got there first), dismissed, or the post was deleted under it.
  if (!mention || mention.status !== 'pending') return;
  if (!mention.summon || mention.run_blocked) return;
  // Something ran it while it waited its turn.
  if (mention.session_id) return;

  const thread = await forumThreadRepository.findById(item.threadId);
  if (!thread || thread.status !== 'open') {
    log.info({ mentionId: item.mentionId }, 'thread not open — wake skipped');
    return;
  }

  // The one loop guard left. Claimed *before* the run, not after, so a run that dies on an
  // unreachable endpoint still spends its unit — otherwise a failing pair would retry each other
  // forever, which is the exact shape a budget exists to stop. A thread inside a project draws on
  // the project's allowance, claimed on the hub, so opening a fifth thread for the same work does
  // not buy four more budgets.
  const target = budgetTargetFor(thread, settings);
  const windowMs = autoRunWindowMs(settings.forum_auto_reply_window_hours);
  const spent = await forumThreadRepository.claimAutoRun(target.id, target.budget, windowMs);
  if (spent === null) {
    log.warn(
      { threadId: item.threadId, title: item.threadTitle, budget: target.budget, isProject: target.isProject },
      'thread has spent its auto-reply budget — mention left pending for a manual run',
    );
    await forumMentionRepository.update(mention._id, { run_blocked: 'budget' });
    await notifyExhausted(item, target, windowMs);
    return;
  }

  log.info(
    { agent: item.agentName, thread: item.threadTitle, spent, budget: target.budget },
    'running a woken mention',
  );
  const run = await forumMentionRunner.begin(item.mentionId, { reason: 'summon' });
  // Waiting is the point: the next agent named in the same post must read this answer on the thread
  // before it forms its own.
  await run.done;
}

/**
 * Tell the operator a thread has stopped answering itself.
 *
 * Without this, exhaustion is a `log.warn` in a container nobody is tailing: the mentions stay
 * pending, the agents never wake, and a thread that has quietly stopped moving is indistinguishable
 * from one where everybody is busy. One alert per window, claimed atomically on the thread that
 * carries the counter, so a project raises one rather than one per child thread.
 */
async function notifyExhausted(
  item: Queued,
  target: { id: Types.ObjectId; budget: number; isProject: boolean },
  windowMs: number,
): Promise<void> {
  if (!(await forumThreadRepository.claimAutoRunNotice(String(target.id)))) return;
  const window = windowMs > 0 ? `in the last ${Math.round(windowMs / 3_600_000)}h` : 'in total';
  // Naming the *project* matters more than it looks: told only the child thread's name, the operator
  // opens it, sees `auto_run_count: 0` on it, and concludes the budget is broken.
  const hub = target.isProject ? await forumThreadRepository.findById(String(target.id)) : null;
  const subject = hub ? `project "${hub.title}"` : `"${item.threadTitle}"`;
  const scope = hub
    ? 'Every thread in it shares one allowance, so opening another thread under it does not buy more. '
    : '';

  await notificationRepository
    .create({
      title: hub
        ? `Forum project out of auto-reply budget: ${hub.title}`
        : `Forum thread out of auto-reply budget: ${item.threadTitle}`,
      content:
        `${subject} has spent its ${target.budget} automatic replies ${window}, so ` +
        `\`${item.authorName}\` → \`@${item.agentName}\` on "${item.threadTitle}" was not woken and ` +
        `its mention is waiting. ${scope}` +
        'Nothing is lost — run the mention by hand from the thread, or raise the budget in Settings. ' +
        'If those two are paging each other in circles here, that is what this limit caught.',
      kind: 'forum_thread',
      ref_id: String(target.id),
    })
    .catch((err) => log.error({ err: String(err), threadId: item.threadId }, 'exhaustion alert failed'));
}
