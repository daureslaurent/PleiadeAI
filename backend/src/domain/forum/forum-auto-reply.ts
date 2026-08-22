import type { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { notificationRepository } from '../notifications/notification.repository';
import { settingsService } from '../settings/settings.service';
import { forumMentionRepository } from './forum-mention.repository';
import { forumMentionRunner } from './forum-mention-runner';
import { autoRunWindowMs, budgetTargetFor, forumThreadRepository } from './forum-thread.repository';

const log = createLogger('forum-auto-reply');

/**
 * Why this mention is being run.
 *
 * `summon` — somebody asked for a turn (`wake`, `@run:`, or the operator naming somebody), and the
 * run happens the moment the post lands. `sweep` — nobody asked, the mention has been sitting
 * unanswered, and the board is running it so the work does not stop. The two differ in what they are
 * allowed to run and in what depth the resulting posts sit at, and nowhere else.
 */
export type AutoReplyReason = 'summon' | 'sweep';

/** One mention waiting for its turn to run, with enough context to log why it did or didn't. */
interface Queued {
  mentionId: string;
  threadId: string;
  threadTitle: string;
  agentName: string;
  /** Who summoned it — half of the pair the rate guard counts. */
  authorName: string;
  reason: AutoReplyReason;
}

/**
 * The board-wide queue. A single array, drained one at a time, deliberately:
 *
 * - Several agents named in one post must answer **in the order they were named** — the operator
 *   writing "@architect then @developer" is describing a sequence, and each agent has to see the
 *   previous one's *posted* reply, which only exists once that run has finished.
 * - Two runs at once contend for the same agents (a mention run yields to a live operator chat via
 *   `SessionLock`, and two mention runs on one agent would simply queue behind each other anyway)
 *   and for one inference endpoint.
 *
 * In memory rather than a collection: a restart mid-queue leaves the mentions `pending`, which is
 * exactly the state the operator's manual Run expects. Nothing is lost, it just stops being
 * automatic — the honest failure mode for a convenience.
 */
const queue: Queued[] = [];
let draining = false;

export const forumAutoReply = {
  /**
   * Offer a post's freshly recorded mentions to the queue, in the order they were written.
   *
   * Only the cheap, stable filters run here (the fleet switch, the target being an agent at all).
   * Everything that can change while a mention waits its turn — the switch itself, the thread being
   * locked, the budget, whether the operator answered it by hand in the meantime — is re-checked at
   * the moment it runs, because a queue drains slowly by design.
   */
  async enqueue(
    rows: Array<{
      mentionId: string;
      threadId: string;
      threadTitle: string;
      agentId: string | null;
      agentName: string;
      authorName: string;
      /** Already decided by `planSummons`: this is a summons, and no guard withheld it. */
      eligible: boolean;
    }>,
  ): Promise<void> {
    const settings = await settingsService.get();
    if (!settings.forum_auto_reply) return;

    const eligible = rows.filter((r) => r.eligible && r.agentId);
    if (!eligible.length) return;

    for (const row of eligible) {
      queue.push({
        mentionId: row.mentionId,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        agentName: row.agentName,
        authorName: row.authorName,
        reason: 'summon',
      });
    }
    log.info(
      { queued: eligible.map((r) => r.agentName), depth: queue.length },
      'mentions queued for auto-reply',
    );
    void drain();
  },

  /**
   * The sweeper's door onto the same queue (`FORUM_AUTORUN_PLAN.md`).
   *
   * Deliberately the same queue and the same `runOne`, not a parallel path: every guard that makes
   * an automatic run safe — the pair cap, the budget claim, the thread-open check, the yield to a
   * live operator chat — has to apply identically whether an agent asked for the turn or the board
   * decided to give it one. A second drain loop would be a second place for those to drift.
   *
   * Returns false when the mention is already waiting, which is the cheap half of the double-run
   * guard; the durable half is the `session_id` filter on the candidate query.
   */
  offer(row: Omit<Queued, 'reason'>): boolean {
    if (queue.some((q) => q.mentionId === row.mentionId)) return false;
    queue.push({ ...row, reason: 'sweep' });
    void drain();
    return true;
  },

  /**
   * True while anything is queued or running.
   *
   * The sweeper's overlap guard: a fan-out of three summonses drains serially and each one is a full
   * turn, so a tick landing in the middle of that should stand aside rather than add a fourth.
   */
  isBusy(): boolean {
    return draining || queue.length > 0;
  },
};

/**
 * Drain the queue, strictly one run at a time. Re-entrant calls return immediately — the loop
 * already running picks up whatever they pushed, so `enqueue` never has to know whether it is
 * starting the parade or joining it.
 */
async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await runOne(next).catch((err) =>
        log.error({ err: String(err), mentionId: next?.mentionId }, 'auto-reply run failed'),
      );
    }
  } finally {
    draining = false;
  }
}

/**
 * Run one queued mention, if it still deserves it.
 *
 * Every reason to decline leaves the mention `pending` rather than dismissed: the operator's Run
 * button is the fallback for all of them, and silently marking a mention answered when nothing
 * answered it would be the one outcome nobody could debug.
 */
async function runOne(item: Queued): Promise<void> {
  const settings = await settingsService.get();
  if (!settings.forum_auto_reply) return;

  const mention = await forumMentionRepository.findById(item.mentionId);
  // Already answered (the operator got there first), dismissed, or the post was deleted under it.
  if (!mention || mention.status !== 'pending') return;
  // A guard withheld this one and the operator was told; nothing automatic may overturn that.
  if (mention.run_blocked) return;
  // A summons the plan already withheld never reaches the queue; this covers the row being
  // re-examined after the fact, and costs one field read. A swept row is by definition not a
  // summons — that is the whole point of sweeping it — so the check applies only to the other path.
  if (item.reason === 'summon' && !mention.summon) return;
  // Something ran it while it waited its turn: the operator's Run, or an earlier sweep.
  if (item.reason === 'sweep' && mention.session_id) return;

  const thread = await forumThreadRepository.findById(item.threadId);
  if (!thread || thread.status !== 'open') {
    log.info({ mentionId: item.mentionId }, 'thread not open — auto-reply skipped');
    return;
  }

  const windowStart = (ms: number): Date | null => (ms > 0 ? new Date(Date.now() - ms) : null);

  // The pair guard (§11.7). A ceiling on total runs per thread cannot tell a five-agent relay from
  // two agents bouncing a conclusion back and forth — the second is what actually happened on the
  // live board, and it is recognisable by name: A summoning B on the same thread, over and over.
  // Checked here rather than at post time because it is time-windowed, and a mention can wait.
  const pairCap = Math.max(1, settings.forum_mention_max_per_pair ?? 2);
  const authorAgentId = mention.author.kind === 'agent' ? mention.author.agent_id : null;
  const targetAgentId = mention.target.agent_id;
  if (authorAgentId && targetAgentId) {
    const seen = await forumMentionRepository.countPair(
      item.threadId,
      authorAgentId,
      targetAgentId,
      windowStart(autoRunWindowMs(settings.forum_auto_reply_window_hours)),
    );
    // `>` not `>=` *when this row is already inside the count* — a summons is, and so is anything
    // that has already been given a session. A swept bare mention is neither at this instant, so it
    // has to add itself or every pair would get one free run beyond the cap, on precisely the path
    // with no chain ceiling behind it.
    const selfCounted = mention.summon === true || mention.session_id != null;
    if (seen + (selfCounted ? 0 : 1) > pairCap) {
      log.warn(
        { thread: item.threadTitle, from: item.authorName, to: item.agentName, seen, pairCap, reason: item.reason },
        'pair has summoned each other too often on this thread — mention left pending for a manual run',
      );
      await forumMentionRepository.update(mention._id, { run_blocked: 'pair_rate' });
      return;
    }
  }

  // The loop guard. Claimed *before* the run, not after, so a run that dies on an unreachable
  // endpoint still spends its unit — otherwise a failing pair of agents would retry each other
  // forever, which is the exact shape the budget exists to stop.
  // A thread inside a project draws on the project's allowance, claimed on the hub, so opening a
  // fifth thread for the same work does not buy four more budgets.
  const target = budgetTargetFor(thread, settings);
  const windowMs = autoRunWindowMs(settings.forum_auto_reply_window_hours);
  const spent = await forumThreadRepository.claimAutoRun(target.id, target.budget, windowMs);
  if (spent === null) {
    log.warn(
      {
        threadId: item.threadId,
        title: item.threadTitle,
        budgetThreadId: String(target.id),
        isProject: target.isProject,
        budget: target.budget,
        windowMs,
        reason: item.reason,
      },
      'thread has spent its auto-reply budget — mention left pending for a manual run',
    );
    await forumMentionRepository.update(mention._id, { run_blocked: 'budget' });
    await notifyExhausted(item, target, windowMs);
    return;
  }

  log.info(
    { agent: item.agentName, thread: item.threadTitle, spent, budget: target.budget, reason: item.reason },
    'auto-replying to mention',
  );
  // A swept run begins a chain rather than continuing one — nobody asked for it, which is the same
  // reading a cron start and an auto-mode tick already get.
  const run = await forumMentionRunner.begin(item.mentionId, {
    resetChain: item.reason === 'sweep',
    reason: item.reason,
  });
  // Waiting is the point: the next agent named in the same post must read this answer on the thread
  // before it forms its own.
  await run.done;
}

/**
 * Tell the operator a thread has stopped answering itself.
 *
 * Without this, exhaustion is a `log.warn` in a container nobody is tailing: the mentions stay
 * pending, the agents never wake, and a coordination thread that has quietly stopped moving is
 * indistinguishable from one where everybody is simply busy. The alert names the thread and says
 * what to do about it, because both fixes — press Run, or raise the ceiling — are the operator's.
 *
 * One alert per window, claimed atomically on the thread, so a thread being mentioned every minute
 * does not fill the inbox with the same sentence.
 */
async function notifyExhausted(
  item: Queued,
  target: { id: Types.ObjectId; budget: number; isProject: boolean },
  windowMs: number,
): Promise<void> {
  // Claimed on whichever thread carries the counter, so a project raises one alert rather than one
  // per child thread.
  if (!(await forumThreadRepository.claimAutoRunNotice(String(target.id)))) return;
  const window = windowMs > 0 ? `in the last ${Math.round(windowMs / 3_600_000)}h` : 'in total';

  // Naming the *project* matters more than it looks: told only the child thread's name, the operator
  // opens it, sees `auto_run_count: 0` on it, and concludes the budget is broken.
  const hub = target.isProject ? await forumThreadRepository.findById(String(target.id)) : null;
  const subject = hub ? `project "${hub.title}"` : `"${item.threadTitle}"`;
  const scope = hub
    ? `Every thread in it shares one allowance, so opening another thread under it does not buy more. `
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
