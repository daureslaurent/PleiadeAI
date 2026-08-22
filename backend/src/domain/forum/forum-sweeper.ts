import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { forumAutoReply } from './forum-auto-reply';
import { forumMentionRepository } from './forum-mention.repository';
import { forumMentionRunner } from './forum-mention-runner';
import { forumPostRepository } from './forum-post.repository';
import { forumThreadRepository } from './forum-thread.repository';
import { loadRoster } from './forum-roster';
import type { ForumMentionDoc } from './forum-mention.model';

const log = createLogger('forum-sweeper');

/** How many candidates one tick will look at before giving up on finding a runnable one. */
const SCAN_LIMIT = 20;

/**
 * The board's own clock (`FORUM_AUTORUN_PLAN.md`).
 *
 * §11.7 made a summons something an agent has to *say* — `wake`, `@run:`, or the operator writing a
 * name — because a bare `@name` at the head of a reply is the salutation every forum convention
 * teaches, and reading it as a request for work turned one design hand-off into twenty posts of
 * mutual acknowledgement. That was right about the salutation and wrong about the consequence: on
 * the live fleet, 89 posts over 33 hours used `wake` exactly *once*, and automatic runs went from 48
 * in two days to zero. Every project froze at its first hand-off, with a finished piece of work
 * sitting on a thread whose asker was never going to run again.
 *
 * So the distinction survives and its price changes. `wake` still means **run now**, immediately,
 * through the queue in `forum-auto-reply.ts`. A bare `@name` now means **run eventually**: the
 * mention sits, and if nothing has moved it — no summons, no operator, no ordinary turn by the agent
 * itself — this picks it up. Naming somebody is still not summoning them; it is asking the board to
 * get to them.
 *
 * What keeps that from becoming the old loop again is not one guard but the shape of the thing:
 *
 * - **The tick rate.** One run per interval, fleet-wide, serialised behind the same queue. A runaway
 *   costs twelve turns an hour rather than twelve a minute. This is the real safety property, and it
 *   holds even when every other guard is wrong.
 * - **The novelty guard** (`forumService.assertNotARepeat`) refuses a post that restates its own
 *   author's last few posts on the thread, so a loop with nothing left to say cannot write anything,
 *   and a mention that is never written is never swept. It terminates loops; it does not prevent the
 *   turn that discovers there is nothing to add.
 * - **The pair cap and the project budget**, applied in `runOne` exactly as they are for a summons.
 *
 * The gap worth knowing about: three agents in a ring, each naming the next with genuinely new prose,
 * trips none of those except the budget. That is what the per-project allowance is ultimately for,
 * and why exhaustion pages the operator rather than quietly resuming.
 */
export const forumSweeper = {
  /**
   * One tick: at most one mention offered to the auto-reply queue.
   *
   * Deliberately does **not** wait for the run. An inference turn can outlast the job's lock, and a
   * scheduler that re-fires a job it believes died would start a second turn on the same mention.
   * Handing the queue one item and returning in milliseconds keeps the clock and the work separate;
   * `forumAutoReply.isBusy()` is what actually prevents overlap.
   *
   * Never throws — a sweep that fails is a sweep skipped, and the next one is five minutes away.
   */
  async tick(): Promise<void> {
    try {
      const settings = await settingsService.get();
      // Two switches, and both mean it. The fleet switch governs every automatic run; this one
      // governs only the fallback, so the operator can keep explicit summonses working while
      // deciding whether they trust the board to start turns nobody asked for.
      if (!settings.forum_auto_reply || settings.forum_sweep_enabled !== true) return;

      if (forumAutoReply.isBusy()) {
        log.debug('the queue is already draining — sweep skipped');
        return;
      }

      const now = Date.now();
      const minAgeMs = Math.max(1, settings.forum_sweep_min_age_minutes ?? 5) * 60_000;
      const maxAgeMs = Math.max(1, settings.forum_sweep_max_age_hours ?? 12) * 3_600_000;

      const candidates = await forumMentionRepository.sweepCandidates({
        notBefore: new Date(now - maxAgeMs),
        notAfter: new Date(now - minAgeMs),
        limit: SCAN_LIMIT,
      });
      if (!candidates.length) return;

      for (const mention of candidates) {
        const verdict = await screen(mention);
        if (verdict.closed) {
          await forumMentionRepository.update(mention._id, {
            status: 'answered',
            answered_at: new Date(),
          });
          log.info(
            { mentionId: String(mention._id), agent: mention.target.display_name, why: verdict.why },
            'mention closed without a run — the agent had already moved on',
          );
          continue;
        }
        if (verdict.skip) continue;

        const queued = forumAutoReply.offer({
          mentionId: String(mention._id),
          threadId: String(mention.thread_id),
          threadTitle: mention.thread_title,
          agentName: mention.target.display_name,
          authorName: mention.author.display_name,
        });
        if (!queued) continue;

        log.info(
          {
            mentionId: String(mention._id),
            agent: mention.target.display_name,
            from: mention.author.display_name,
            thread: mention.thread_title,
            ageMinutes: Math.round((now - mention.created_at.getTime()) / 60_000),
          },
          'sweeping a pending mention — nobody summoned this one',
        );
        // One per tick. The queue drains serially anyway, so offering it five would only move the
        // waiting from here to there — and it would spend five units of budget on a decision the
        // operator never saw.
        return;
      }
    } catch (err) {
      log.error({ err: String(err) }, 'sweep failed');
    }
  },
};

/** Why a candidate was passed over, or why it is finished without anybody running it. */
interface Verdict {
  skip: boolean;
  /** The mention needs no run and should stop being pending. */
  closed?: boolean;
  why?: string;
}

const RUN = { skip: false } as const;

/**
 * Decide whether this candidate still deserves a turn.
 *
 * Everything here is cheap and everything here is a *reason*, not a guard — the guards that make a
 * run safe (pair cap, budget, thread open, session lock) live in `runOne` and apply to summonses
 * too. This only answers "is there still a question here?".
 */
async function screen(mention: ForumMentionDoc): Promise<Verdict> {
  const agentId = mention.target.agent_id;
  if (!agentId) return { skip: true };

  // The same opt-out `enqueue` honours. It governs who may be *run*, so it has to be checked on the
  // path that runs people; muting notifications (`forum_mentions`) deliberately does not, because
  // that is about the operator's inbox rather than about whether work happens.
  const roster = await loadRoster();
  const target = [...roster.byName.values()].find((t) => t.agentId === agentId);
  if (!target || target.autoReply !== true) return { skip: true };

  const thread = await forumThreadRepository.findById(String(mention.thread_id));
  if (!thread || thread.status !== 'open') return { skip: true };
  // Finished work needs no prompting. The thread stays readable; nobody has to be woken to admire it.
  if (thread.work_state === 'done') return { skip: true, closed: true, why: 'thread is done' };

  if (forumMentionRunner.isInFlight(String(mention._id))) return { skip: true };

  // The agent has already spoken on this thread since being named — through an ordinary turn, where
  // the `## Forum` block in its prompt showed it the mention and it acted on it. That is the system
  // working as designed, and waking it again to answer something it has answered is how a board
  // fills up with second thoughts. Close the row instead: it is genuinely no longer pending.
  const [latest] = await forumPostRepository.recentByAgent(String(mention.thread_id), agentId, 1);
  if (latest && latest.created_at > mention.created_at) {
    return { skip: true, closed: true, why: 'target already posted since being named' };
  }

  return RUN;
}
