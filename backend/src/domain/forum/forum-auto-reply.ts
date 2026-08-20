import { createLogger } from '../../config/logger';
import { notificationRepository } from '../notifications/notification.repository';
import { settingsService } from '../settings/settings.service';
import { forumMentionRepository } from './forum-mention.repository';
import { forumMentionRunner } from './forum-mention-runner';
import { autoRunWindowMs, forumThreadRepository } from './forum-thread.repository';

const log = createLogger('forum-auto-reply');

/** One mention waiting for its turn to run, with enough context to log why it did or didn't. */
interface Queued {
  mentionId: string;
  threadId: string;
  threadTitle: string;
  agentName: string;
  /** Who summoned it — half of the pair the rate guard counts. */
  authorName: string;
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
      });
    }
    log.info(
      { queued: eligible.map((r) => r.agentName), depth: queue.length },
      'mentions queued for auto-reply',
    );
    void drain();
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
  // A summons the plan already withheld never reaches the queue; this covers the row being
  // re-examined after the fact, and costs one field read.
  if (!mention.summon || mention.run_blocked) return;

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
    // `>` not `>=`: this mention is itself already counted, so the cap is "this many, then stop".
    if (seen > pairCap) {
      log.warn(
        { thread: item.threadTitle, from: item.authorName, to: item.agentName, seen, pairCap },
        'pair has summoned each other too often on this thread — mention left pending for a manual run',
      );
      await forumMentionRepository.update(mention._id, { run_blocked: 'pair_rate' });
      return;
    }
  }

  // The loop guard. Claimed *before* the run, not after, so a run that dies on an unreachable
  // endpoint still spends its unit — otherwise a failing pair of agents would retry each other
  // forever, which is the exact shape the budget exists to stop.
  const budget = settings.forum_auto_reply_max_per_thread;
  const windowMs = autoRunWindowMs(settings.forum_auto_reply_window_hours);
  const spent = await forumThreadRepository.claimAutoRun(thread._id, budget, windowMs);
  if (spent === null) {
    log.warn(
      { threadId: item.threadId, title: item.threadTitle, budget, windowMs },
      'thread has spent its auto-reply budget — mention left pending for a manual run',
    );
    await forumMentionRepository.update(mention._id, { run_blocked: 'budget' });
    await notifyExhausted(item, budget, windowMs);
    return;
  }

  log.info(
    { agent: item.agentName, thread: item.threadTitle, spent, budget },
    'auto-replying to mention',
  );
  const run = await forumMentionRunner.begin(item.mentionId);
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
async function notifyExhausted(item: Queued, budget: number, windowMs: number): Promise<void> {
  if (!(await forumThreadRepository.claimAutoRunNotice(item.threadId))) return;
  const window = windowMs > 0 ? `in the last ${Math.round(windowMs / 3_600_000)}h` : 'in total';
  await notificationRepository
    .create({
      title: `Forum thread out of auto-reply budget: ${item.threadTitle}`,
      content:
        `"${item.threadTitle}" has spent its ${budget} automatic replies ${window}, so ` +
        `\`${item.authorName}\` → \`@${item.agentName}\` was not woken and its mention is waiting. ` +
        'Nothing is lost — run the mention by hand from the thread, or raise the budget in Settings. ' +
        'If those two are paging each other in circles here, that is what this limit caught.',
      kind: 'forum_thread',
      ref_id: item.threadId,
    })
    .catch((err) => log.error({ err: String(err), threadId: item.threadId }, 'exhaustion alert failed'));
}
