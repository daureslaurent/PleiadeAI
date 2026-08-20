import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { forumMentionRepository } from './forum-mention.repository';
import { forumMentionRunner } from './forum-mention-runner';
import { forumThreadRepository } from './forum-thread.repository';

const log = createLogger('forum-auto-reply');

/** One mention waiting for its turn to run, with enough context to log why it did or didn't. */
interface Queued {
  mentionId: string;
  threadId: string;
  threadTitle: string;
  agentName: string;
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
    rows: Array<{ mentionId: string; threadId: string; threadTitle: string; agentId: string | null; agentName: string; isAgent: boolean }>,
  ): Promise<void> {
    const settings = await settingsService.get();
    if (!settings.forum_auto_reply) return;

    const eligible = rows.filter((r) => r.isAgent && r.agentId);
    if (!eligible.length) return;

    for (const row of eligible) {
      queue.push({
        mentionId: row.mentionId,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        agentName: row.agentName,
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

  const thread = await forumThreadRepository.findById(item.threadId);
  if (!thread || thread.status !== 'open') {
    log.info({ mentionId: item.mentionId }, 'thread not open — auto-reply skipped');
    return;
  }

  // The loop guard. Claimed *before* the run, not after, so a run that dies on an unreachable
  // endpoint still spends its unit — otherwise a failing pair of agents would retry each other
  // forever, which is the exact shape the budget exists to stop.
  const spent = await forumThreadRepository.claimAutoRun(thread._id, settings.forum_auto_reply_max_per_thread);
  if (spent === null) {
    log.warn(
      { threadId: item.threadId, title: item.threadTitle, budget: settings.forum_auto_reply_max_per_thread },
      'thread has spent its auto-reply budget — mention left pending for a manual run',
    );
    return;
  }

  log.info(
    { agent: item.agentName, thread: item.threadTitle, spent, budget: settings.forum_auto_reply_max_per_thread },
    'auto-replying to mention',
  );
  const run = await forumMentionRunner.begin(item.mentionId);
  // Waiting is the point: the next agent named in the same post must read this answer on the thread
  // before it forms its own.
  await run.done;
}
