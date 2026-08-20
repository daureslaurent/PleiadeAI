import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { ForumPostModel } from './forum-post.model';
import { ForumThreadModel } from './forum-thread.model';
import { forumIndexService } from './forum-index.service';
import { ForumMentionModel } from './forum-mention.model';
import { loadRoster, OPERATOR_HANDLE } from './forum-roster';

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
/** Roster descriptions are clipped hard — the line exists to make `@name` spellable, not to brief. */
const MAX_ROSTER_DESC_CHARS = 60;
/**
 * Above this many agents the roster is names-only. A fleet of forty with a description each is a
 * paragraph nobody reads; the names alone still do the one job the roster has to do.
 */
const MAX_ROSTER_WITH_DESC = 12;

export interface ForumPointer {
  threadId: string;
  title: string;
  /** Present for mention pointers: who addressed the agent by name. */
  mentionedBy?: string;
  /** Present for reply pointers: who posted the reply the agent hasn't seen. */
  lastPostAuthor?: string;
  /** Present for digest pointers: whether the thread itself is new, or just newly replied to. */
  opening?: boolean;
  /** Present for assignment pointers: the work state the thread is sitting in. */
  workState?: string;
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
   * The work items this agent owns and has not finished (§13).
   *
   * A mention pointer disappears the moment the agent answers, which is right for a question and
   * wrong for a task: "you own this, it is still open" is true on every turn until the work is
   * actually done, and an assignment that scrolls out of view after one reply is an assignment
   * nobody tracks. `done` is excluded — it is finished by definition — and so are archived threads.
   *
   * Cheap by construction: one indexed find on `assignee.display_name` + `work_state`.
   */
  async assigned(agentId: string, limit = MAX_POINTERS): Promise<ForumPointer[]> {
    if (!agentId) return [];
    try {
      const rows = await ForumThreadModel.find({
        'assignee.agent_id': agentId,
        work_state: { $in: ['todo', 'in_progress', 'blocked'] },
        status: { $ne: 'archived' },
      })
        .sort({ last_post_at: -1 })
        .limit(limit)
        .exec();
      return rows.map((t) => ({
        threadId: String(t._id),
        title: clip(t.title),
        workState: t.work_state ?? 'todo',
        lastPostAuthor: t.last_post_author,
      }));
    } catch (err) {
      log.warn({ err, agentId }, 'forum assignment pointers unavailable this turn');
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

  /**
   * Who this agent can address by name.
   *
   * An `@mention` only resolves against an *exact* agent name, so an agent that cannot spell the
   * roster cannot use the feature at all — and the only way to learn a name was `annuaire`, which is
   * an extra tool call *and* lists subagents only, leaving top-level peers literally unnameable. Two
   * skipped steps between "I should ask someone" and actually asking is two too many, so the names
   * ride in the block instead.
   *
   * Built from `loadRoster` — the same list `parseMentions` resolves against, 30s-cached and shared
   * with the write path — because a roster that offers a name mentions would not match is worse than
   * no roster at all. The agent's own name is dropped: a self-mention is discarded on write.
   */
  async roster(agentName: string): Promise<string[]> {
    try {
      const { byName } = await loadRoster();
      const targets = [...byName.values()].filter(
        (t) => t.name.toLowerCase() !== agentName.toLowerCase(),
      );
      if (!targets.length) return [];

      // Operator last: it is always present, and the agents are the part worth reading first.
      targets.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'operator' ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      const withDesc = targets.length <= MAX_ROSTER_WITH_DESC;
      return targets.map((t) => {
        if (t.kind === 'operator') return `@${OPERATOR_HANDLE} — the human running this fleet`;
        const desc = (t.description || '').replace(/\s+/g, ' ').trim();
        if (!withDesc || !desc) return `@${t.name}`;
        const clipped =
          desc.length <= MAX_ROSTER_DESC_CHARS ? desc : `${desc.slice(0, MAX_ROSTER_DESC_CHARS)}…`;
        return `@${t.name} — ${clipped}`;
      });
    } catch (err) {
      log.warn({ err }, 'forum roster unavailable this turn');
      return [];
    }
  },
};

/**
 * Render the forum block folded into the leading system message.
 *
 * The wording is load-bearing, and it does three things the pointers alone cannot.
 *
 * It states plainly that the ids are *pointers*, so the model doesn't answer from a title as though
 * it had read the thread.
 *
 * It carries the **roster**, because `@name` must match an agent's exact name and an agent that
 * can't spell one can't address anybody — every instruction below is inert without it.
 *
 * And it draws the **routing rule**: `ask_agent` answers inside this turn and is right for a lookup
 * or a web search; anything long, open-ended or multi-step belongs on the board, where it survives
 * the turn, is visible to the operator, and can be picked up by whoever owns it. Without that
 * sentence the two paths look interchangeable and the model picks the synchronous one every time,
 * which is how a fleet ends up with a board that is an archive nobody writes to.
 *
 * The posting triggers stay **conditional** — tied to having learned something durable, being
 * blocked, or finding something the fleet is wrong about — because an agent told it must post every
 * turn files "task completed successfully" a hundred times, and a board of that is one no agent has
 * any reason to read again.
 */
/** ` · 2 files` — omitted entirely when a thread has none, so the common line stays as short as it was. */
function files(p: ForumPointer): string {
  return p.attachments ? ` · ${p.attachments} file${p.attachments === 1 ? '' : 's'}` : '';
}

export interface ForumBlockInput {
  related: ForumPointer[];
  replies: ForumPointer[];
  digest?: ForumPointer[];
  mentions?: ForumPointer[];
  /** `@name — role` lines from `forumRecall.roster`. */
  roster?: string[];
  /** Open work items assigned to this agent (spec §13). */
  assigned?: ForumPointer[];
  /** Whether the board runs mentions on its own (`settings.forum_auto_reply`, spec §11.6). */
  autoReply?: boolean;
}

export function buildForumBlock(input: ForumBlockInput): string | null {
  const {
    related,
    replies,
    digest = [],
    mentions = [],
    assigned = [],
    roster = [],
    autoReply = false,
  } = input;

  // The roster alone is not a reason to spend tokens: an agent with nothing pending and nothing
  // related gets the block only because the instructions below are what change its behaviour.
  const lines = ['## Forum'];

  // Mentions lead: being asked something directly outranks a thread that merely looked topical.
  if (mentions.length) {
    lines.push(
      '',
      'You were addressed by name on the forum and have not answered yet. Read the thread and',
      '`reply` to it in this turn — your reply is posted straight back to whoever asked. If you have',
      'nothing to add beyond what the thread already says, say that in one line and stop:',
      ...mentions.map((p) => `- \`${p.threadId}\` — ${p.title} (by ${p.mentionedBy})${files(p)}`),
    );
  }

  // Straight after mentions: an assignment outranks anything merely topical, and unlike a mention
  // it stays here every turn until the agent marks it done — which is the nudge to actually do so.
  if (assigned.length) {
    lines.push(
      '',
      'Work items on the forum assigned to **you**, still open. Move them along, and keep their',
      'state honest with `forum` `set_state` (`in_progress` when you start, `blocked` with a reply',
      'saying what you are waiting on, `done` when it is finished):',
      ...assigned.map((p) => `- \`${p.threadId}\` — ${p.title} [${p.workState}]${files(p)}`),
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

  if (roster.length) {
    lines.push(
      '',
      'Agents you can address, by writing `@name` anywhere in a post (exact name, as written here):',
      ...roster.map((line) => `- ${line}`),
      '',
      '**Naming somebody is not the same as summoning them.** `@name` tells them: it shows on their',
      'next turn, and nothing else happens. To make an agent take a turn *now*, pass its name in the',
      '`wake` argument of your `forum` call. Each name there is a full inference run, so wake somebody',
      'only when you need something *from* them to go further, and say in the post what you need.',
      '',
      'Answering, acknowledging, confirming and reporting done wake **nobody**. Your post is already',
      'on the thread the other agent is watching — that is how they hear it. Waking back whoever just',
      'woke you is how two agents spend an afternoon agreeing with each other, and it is refused.',
    );
  }

  lines.push(
    '',
    'The board is how this fleet works together, not just where it files notes. Use it to:',
    '',
    '- **Hand off heavy work.** `ask_agent` is for something you need answered *inside this turn* —',
    '  a web search, a lookup, one quick check. Anything long, open-ended or multi-step should go on',
    '  the board instead: open a thread saying what you need and why, `wake` the agent whose job it',
    '  is, and get on with your own part.' +
      (roster.length
        ? autoReply
          ? ' A woken agent runs on its own and its answer lands in the thread.'
          : ' The operator decides when they run.'
        : ''),
    '- **Raise anything the fleet is wrong about, immediately.** A broken dependency, a service that',
    '  is down, an assumption other agents are working from that you have just disproved, a decision',
    '  that changes how everyone should proceed. Post it when you find it, not when you finish.',
    '- **Answer what you are asked.** Silence on a thread reads as a dropped request, and "I don\'t',
    '  know, but X does" is a complete answer.',
    '- **Record what would cost another agent an hour to rediscover** — a root cause, a fix that',
    '  worked, a dead end worth not repeating. Nothing worth keeping, nothing to post.',
    '',
    'Search before you open a thread; reply to the existing one if there is one. Post only what the',
    'thread does not already say — restating your own last post there is refused, and restating',
    'somebody else\'s is how a thread stops being worth reading.',
  );

  return lines.join('\n');
}
