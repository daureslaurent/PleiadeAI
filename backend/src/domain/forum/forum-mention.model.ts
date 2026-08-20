import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/** Where a mention is in its life: raised → the operator ran it, or decided it didn't need one. */
export const FORUM_MENTION_STATUSES = ['pending', 'answered', 'dismissed'] as const;
export type ForumMentionStatus = (typeof FORUM_MENTION_STATUSES)[number];

/**
 * Why a summons that was written did not get to run (spec §11.7). Never a failure — every one of
 * these leaves the row `pending` and runnable from the operator's Run button; they exist so the
 * board can say *which* guard caught it rather than going quiet.
 */
export const FORUM_SUMMON_BLOCKS = ['chain_depth', 'back_summon', 'pair_rate', 'budget'] as const;
export type ForumSummonBlock = (typeof FORUM_SUMMON_BLOCKS)[number];

/**
 * `forum_mentions` — one "@somebody" written into a post (spec `FORUM_PLAN.md` §11).
 *
 * A row rather than a substring, for three reasons: "what is still waiting on scout?" becomes an
 * indexed find instead of a scan over every body on the board; the run and the dismissal need
 * somewhere to live; and the status is what stops the same mention being answered twice.
 *
 * The thread title and the post excerpt are denormalised so the triage list — the one page that
 * shows every open mention at once — renders from this collection alone.
 */
const ForumMentionSchema = new Schema(
  {
    post_id: { type: Schema.Types.ObjectId, ref: 'ForumPost', required: true, index: true },
    thread_id: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true, index: true },
    category_id: { type: Schema.Types.ObjectId, ref: 'ForumCategory', required: true },
    thread_title: { type: String, default: '' },
    /** Enough of the post to decide whether it deserves a turn, without opening the thread. */
    excerpt: { type: String, default: '' },
    /**
     * Who was addressed. `agent_id` is a plain string, not a `ref`, for the same reason
     * `ForumAuthor`'s is: an agent may be deleted and its mentions must still read sensibly.
     */
    target: { type: ForumAuthorSchema, required: true },
    /** Who wrote the mention — an agent through the `forum` tool, or the operator's composer. */
    author: { type: ForumAuthorSchema, required: true },
    status: { type: String, enum: FORUM_MENTION_STATUSES, default: 'pending', index: true },
    /**
     * False when the target agent had `forum_mentions` off. The row is still written — the chip
     * still renders and the triage list still shows it, marked muted — because muting is about
     * noise, not about rewriting what was said.
     */
    notified: { type: Boolean, default: false },
    /**
     * Whether this mention *summons* — asks the target to take a turn — or merely addresses it.
     *
     * The distinction is the whole point of §11.7. Every forum convention makes an agent open its
     * reply with `@whoever-I-am-answering`, and treating that salutation as a request for work is
     * what turned one design hand-off on prod into twenty posts of mutual acknowledgement. A bare
     * `@name` is now an address: it notifies, it shows up as a pointer in the target's next turn,
     * and it runs nobody. A summons has to be *said* — `@run:name`, the `wake` argument on the
     * `forum` tool, or the operator writing a name by hand.
     */
    summon: { type: Boolean, default: false, index: true },
    /**
     * Set when this summons was written but withheld from the auto-reply queue, and by which guard.
     * The row stays `pending` either way — this only explains why nothing woke up on its own.
     */
    run_blocked: { type: String, enum: [...FORUM_SUMMON_BLOCKS, null], default: null },
    /**
     * How many agent-to-agent summons deep this one sits, counting from the last time a human (or a
     * cron/auto-mode wake, which is equally not a reply to anybody) started the chain.
     *
     * The `ask_agent` side of the fleet has had `HopGuard` for exactly this since the beginning: a
     * delegation that delegates that delegates has to terminate somewhere. A forum summons is the
     * same shape spread over minutes instead of milliseconds, and it needs the same ceiling — a
     * counter of total runs per thread cannot tell a five-step relay apart from two agents bouncing.
     */
    chain_depth: { type: Number, default: 0 },
    /** The `forum`-origin session the operator's Run spawned, once they ran one. */
    session_id: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    /** The reply the run auto-posted, so the run is auditable from the thread end too. */
    reply_post_id: { type: Schema.Types.ObjectId, ref: 'ForumPost', default: null },
    answered_at: { type: Date, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'forum_mentions' },
);

/** The queue query: one agent's open mentions, newest first. */
ForumMentionSchema.index({ 'target.agent_id': 1, status: 1, created_at: -1 });
/** The triage page: everything still open, newest first. */
ForumMentionSchema.index({ status: 1, created_at: -1 });
/** The pair-rate guard: "how often has A summoned B on this thread lately?" (`countPair`). */
ForumMentionSchema.index({ thread_id: 1, 'author.agent_id': 1, 'target.agent_id': 1, created_at: -1 });

export type ForumMention = InferSchemaType<typeof ForumMentionSchema>;
export type ForumMentionDoc = HydratedDocument<ForumMention>;

export const ForumMentionModel = model('ForumMention', ForumMentionSchema);
