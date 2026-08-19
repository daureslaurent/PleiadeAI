import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { ForumPostModel } from './forum-post.model';
import { ForumThreadModel } from './forum-thread.model';
import { forumIndexService } from './forum-index.service';
import { ForumMentionModel } from './forum-mention.model';

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
  /** Present for mention pointers: who addressed the agent by name. */
  mentionedBy?: string;
  /** Present for reply pointers: who posted the reply the agent hasn't seen. */
  lastPostAuthor?: string;
  /** Present for digest pointers: whether the thread itself is new, or just newly replied to. */
  opening?: boolean;
  /** Files attached anywhere in the thread. A pointer that says "2 files" is worth opening. */
  attachments?: number;
}

function clip(title: string): string {
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS)}…`;
}

/**
 * Annotate pointers with how many files their threads carry — one aggregation for the whole block,
 * costing ~4 tokens a line. Worth it: "this thread has the crash bundle attached" is exactly the
 * kind of thing that decides whether a pointer is worth opening, and it is invisible from a title.
 * Best-effort: a failure here degrades the pointer, it never fails the turn.
 */
async function withAttachmentCounts(pointers: ForumPointer[]): Promise<ForumPointer[]> {
  const ids = pointers.map((p) => p.threadId).filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return pointers;
  try {
    const rows = await ForumPostModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          thread_id: { $in: ids.map((id) => new Types.ObjectId(id)) },
          deleted: false,
          'attachments.0': { $exists: true },
        },
      },
      { $group: { _id: '$thread_id', n: { $sum: { $size: '$attachments' } } } },
    ]).exec();
    const byThread = new Map(rows.map((r) => [String(r._id), r.n]));
    return pointers.map((p) => (byThread.get(p.threadId) ? { ...p, attachments: byThread.get(p.threadId) } : p));
  } catch (err) {
    log.warn({ err }, 'attachment counts unavailable for forum pointers');
    return pointers;
  }
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
      return withAttachmentCounts(out);
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

  /**
   * Threads where somebody addressed this agent by name and it hasn't answered (spec §11.2).
   *
   * This is the half of a mention that reaches the *agent*. The operator's alert legs fire the
   * instant the mention lands, but an agent doesn't poll and an unread row in a collection is
   * invisible to a model — so the pending mentions ride into its next turn as pointers, worded as
   * the direct address they are.
   *
   * Reading the row is not answering it: `status` only flips when the operator runs the mention, so
   * an agent that happens to run first is reminded rather than silently absolved.
   */
  async mentions(agentId: string, limit = MAX_POINTERS): Promise<ForumPointer[]> {
    if (!agentId) return [];
    try {
      const rows = await ForumMentionModel.find({
        'target.agent_id': agentId,
        status: 'pending',
      })
        .sort({ created_at: -1 })
        .limit(limit)
        .exec();

      // One pointer per thread: being named three times in one thread is still one thing to answer.
      const seen = new Set<string>();
      const out: ForumPointer[] = [];
      for (const row of rows) {
        const threadId = String(row.thread_id);
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        out.push({ threadId, title: clip(row.thread_title), mentionedBy: row.author.display_name });
      }
      return out;
    } catch (err) {
      log.warn({ err, agentId }, 'forum mention pointers unavailable this turn');
      return [];
    }
  },

  /**
   * What has happened on the board *since a moment in time* — for the auto-loop agent
   * (`AUTO_AGENT_PLAN.md` §4), which wakes up every few minutes and would otherwise have no way to
   * notice work it was never directly addressed in.
   *
   * Time-scoped rather than similarity-scoped, and that difference is deliberate: `pointers()` asks
   * "what relates to this task?", which is the right question for a turn the operator drove. A
   * looping agent's question is "what changed while I was working?", and semantic similarity would
   * hide exactly the thread whose subject it hasn't thought of yet. The agent's own threads are
   * excluded — its own posts are not news to it, and `unansweredReplies` already covers answers to
   * them.
   */
  async digest(since: Date, agentName: string, limit = MAX_POINTERS): Promise<ForumPointer[]> {
    try {
      const threads = await ForumThreadModel.find({
        last_post_at: { $gt: since },
        status: 'open',
        last_post_author: { $ne: agentName },
      })
        .sort({ last_post_at: -1 })
        .limit(limit)
        .exec();

      return withAttachmentCounts(
        threads.map((t) => ({
          threadId: String(t._id),
          title: clip(t.title),
          lastPostAuthor: t.last_post_author,
          // A thread whose only post is the opening one is new since the watermark, not merely bumped.
          opening: t.post_count <= 1,
        })),
      );
    } catch (err) {
      log.warn({ err }, 'forum digest unavailable this turn');
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
/** ` · 2 files` — omitted entirely when a thread has none, so the common line stays as short as it was. */
function files(p: ForumPointer): string {
  return p.attachments ? ` · ${p.attachments} file${p.attachments === 1 ? '' : 's'}` : '';
}

export function buildForumBlock(
  related: ForumPointer[],
  replies: ForumPointer[],
  digest: ForumPointer[] = [],
  mentions: ForumPointer[] = [],
): string | null {
  if (!related.length && !replies.length && !digest.length && !mentions.length) return null;

  const lines = ['## Forum'];

  // Mentions lead: being asked something directly outranks a thread that merely looked topical.
  if (mentions.length) {
    lines.push(
      '',
      'You were mentioned by name on the forum and have not answered yet:',
      ...mentions.map((p) => `- \`${p.threadId}\` — ${p.title} (by ${p.mentionedBy})${files(p)}`),
    );
  }

  if (related.length) {
    lines.push(
      '',
      'Threads on the shared agent forum that look related to this task. These are pointers, not',
      'content — call `forum` with `read_thread` to actually read one before relying on it:',
      ...related.map((p) => `- \`${p.threadId}\` — ${p.title}${files(p)}`),
    );
  }

  if (replies.length) {
    lines.push(
      '',
      'Someone has replied to a thread you took part in, and you have not answered:',
      ...replies.map((p) => `- \`${p.threadId}\` — ${p.title} (last reply by ${p.lastPostAuthor})${files(p)}`),
    );
  }

  if (digest.length) {
    lines.push(
      '',
      'New on the board since your last turn (you were not addressed — read only what bears on your goal):',
      ...digest.map(
        (p) =>
          `- \`${p.threadId}\` — ${p.title} (${p.opening ? 'new thread' : 'new reply'} by ${p.lastPostAuthor})${files(p)}`,
      ),
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
