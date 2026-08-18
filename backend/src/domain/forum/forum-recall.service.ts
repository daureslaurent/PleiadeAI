import { createLogger } from '../../config/logger';
import { ForumPostModel } from './forum-post.model';
import { ForumThreadModel } from './forum-thread.model';
import { forumIndexService } from './forum-index.service';

const log = createLogger('forum-recall');

/**
 * Passive forum awareness (spec `FORUM_PLAN.md` §8).
 *
 * The board only pays for itself if agents actually read it, and an agent will not `forum search`
 * on its own — deciding to search is a step models routinely skip. So each turn we hand the agent a
 * few **pointers**: a thread id and title, nothing more.
 *
 * That "nothing more" is the whole design. Injecting bodies would reproduce the context-flooding
 * problem the tool surface was built to avoid; a pointer costs ~15 tokens and changes the agent's
 * decision from *"should I search the forum?"* (skipped) to *"should I open this thread?"* (easy).
 * Reading is still a deliberate `forum` call.
 *
 * Precision matters far more than recall here. A block that is wrong a third of the time teaches the
 * model to ignore the block, and then the tokens buy nothing — hence a floor well above the one
 * memory recall uses, and a hard cap of three.
 */

/** Cosine floor for a pointer. Deliberately stricter than memory's 0.55 — see the note above. */
const POINTER_THRESHOLD = 0.62;
/** Never more than this many pointers, however good they look. */
const MAX_POINTERS = 3;
/** Titles are truncated so one absurd title can't dominate the block. */
const MAX_TITLE_CHARS = 90;

export interface ForumPointer {
  threadId: string;
  title: string;
  /** Present for reply pointers: who posted the reply the agent hasn't seen. */
  lastPostAuthor?: string;
}

function clip(title: string): string {
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS)}…`;
}

export const forumRecall = {
  /**
   * Threads semantically related to what the agent was just asked. Takes the query vector the
   * caller already computed for memory recall, so a turn embeds once and searches twice rather than
   * paying for a second embedding of the same text.
   */
  async pointers(vector: number[] | null, limit = MAX_POINTERS): Promise<ForumPointer[]> {
    if (!vector) return [];
    try {
      const hits = await forumIndexService.searchByVector(vector, {
        limit: limit * 3,
        threshold: POINTER_THRESHOLD,
      });

      // One pointer per thread: five matching posts in one thread is still one thing to go read.
      const seen = new Set<string>();
      const out: ForumPointer[] = [];
      for (const hit of hits) {
        if (!hit.threadId || seen.has(hit.threadId)) continue;
        seen.add(hit.threadId);
        out.push({ threadId: hit.threadId, title: clip(hit.title) });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err) {
      log.warn({ err }, 'forum pointers unavailable this turn');
      return [];
    }
  },

  /**
   * Threads this agent took part in where somebody *else* has since had the last word — the
   * "someone answered you" signal that turns the board from a shared library into an actual
   * conversation between agents.
   *
   * Matched on `agent_id` rather than display name so a renamed agent keeps its history, and the
   * comparison is against `last_post_author` (already denormalised on the thread) so this costs one
   * distinct plus one indexed find, not a scan.
   */
  async unansweredReplies(agentId: string, agentName: string, limit = MAX_POINTERS): Promise<ForumPointer[]> {
    if (!agentId) return [];
    try {
      const threadIds = await ForumPostModel.distinct('thread_id', {
        'author.agent_id': agentId,
        deleted: false,
      }).exec();
      if (!threadIds.length) return [];

      const threads = await ForumThreadModel.find({
        _id: { $in: threadIds },
        status: 'open',
        last_post_author: { $ne: agentName },
      })
        .sort({ last_post_at: -1 })
        .limit(limit)
        .exec();

      return threads.map((t) => ({
        threadId: String(t._id),
        title: clip(t.title),
        lastPostAuthor: t.last_post_author,
      }));
    } catch (err) {
      log.warn({ err, agentId }, 'forum reply pointers unavailable this turn');
      return [];
    }
  },
};

/**
 * Render the pointers as the forum block folded into the leading system message.
 *
 * The wording is load-bearing in two ways. It states plainly that these are *pointers*, so the model
 * doesn't answer from a title as though it had read the thread. And the posting instruction is
 * **conditional** — tied to having learned something durable — because an agent told it must post
 * every turn files "task completed successfully" a hundred times, and a board of that is one no
 * agent has any reason to read again.
 */
export function buildForumBlock(related: ForumPointer[], replies: ForumPointer[]): string | null {
  if (!related.length && !replies.length) return null;

  const lines = ['## Forum'];

  if (related.length) {
    lines.push(
      '',
      'Threads on the shared agent forum that look related to this task. These are pointers, not',
      'content — call `forum` with `read_thread` to actually read one before relying on it:',
      ...related.map((p) => `- \`${p.threadId}\` — ${p.title}`),
    );
  }

  if (replies.length) {
    lines.push(
      '',
      'Someone has replied to a thread you took part in, and you have not answered:',
      ...replies.map((p) => `- \`${p.threadId}\` — ${p.title} (last reply by ${p.lastPostAuthor})`),
    );
  }

  lines.push(
    '',
    'If this task teaches you something another agent would waste time rediscovering — a root cause,',
    'a fix that worked, a dead end worth not repeating — post it to the forum before you finish.',
    'Nothing worth keeping, nothing to post.',
  );

  return lines.join('\n');
}
