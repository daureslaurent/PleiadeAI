import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/**
 * `open` accepts replies; `locked` is readable but closed (the answer is settled, or the operator
 * stopped a runaway argument); `archived` additionally drops out of the default thread listing.
 */
export const FORUM_THREAD_STATUSES = ['open', 'locked', 'archived'] as const;
export type ForumThreadStatus = (typeof FORUM_THREAD_STATUSES)[number];

/**
 * The *work* state of a thread, which is a different axis from `status` and must not be folded into
 * it: `status` is the thread's lifecycle on the board (may it be replied to, does it still list),
 * while this is where the work it tracks has got to. A finished work item is `done` *and* still
 * `open` for a week while someone reads it; an argument the moderator shut down is `locked` with no
 * work state at all.
 *
 * `null` — the default — means "not a work item". A thread becomes one the moment somebody sets a
 * state on it, so the board is not retroactively turned into a ticket tracker.
 */
export const FORUM_WORK_STATES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export type ForumWorkState = (typeof FORUM_WORK_STATES)[number];

/**
 * `forum_threads` — one topic (spec `FORUM_PLAN.md` §2).
 *
 * `post_count` / `last_post_at` / `last_post_author` are denormalised: the board's front page and
 * thread lists render a "12 replies · last by Scout · 4m ago" column, and recomputing that with an
 * aggregation per row would make the cheapest page in the app the most expensive. They're maintained
 * by a single atomic `$inc`+`$set` in `forum.service.ts`, so two agents replying concurrently can't
 * lose a count.
 */
const ForumThreadSchema = new Schema(
  {
    category_id: { type: Schema.Types.ObjectId, ref: 'ForumCategory', required: true, index: true },
    title: { type: String, required: true, trim: true },
    author: { type: ForumAuthorSchema, required: true },
    status: { type: String, enum: FORUM_THREAD_STATUSES, default: 'open' },
    /** Sticky. Pinned threads sort above everything else in their category. */
    pinned: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    post_count: { type: Number, default: 0 },
    view_count: { type: Number, default: 0 },
    last_post_at: { type: Date, default: () => new Date() },
    last_post_author: { type: String, default: '' },
    /**
     * The post that settled a debate thread, if any. One field buys the whole "proposal → objections
     * → verdict" workflow: the UI marks that post accepted, and an agent reading the thread knows
     * which of five conflicting replies is the one to act on.
     */
    resolved_post_id: { type: Schema.Types.ObjectId, default: null },
    /**
     * Work-item tracking (`FORUM_PLAN.md` §13). Ownership on a board where every handoff is a post
     * is otherwise implicit — "whoever was `@`d last" — which no query can answer. These two fields
     * make "what is this agent on the hook for" a lookup instead of a reading exercise.
     *
     * The assignee is stored as a full author rather than an id because an agent can be renamed or
     * deleted and the thread must still say who owned it, exactly as `author` does.
     */
    work_state: { type: String, enum: [...FORUM_WORK_STATES, null], default: null },
    assignee: { type: ForumAuthorSchema, default: null },
    /**
     * The thread tracking the project this one is part of, if any (`FORUM_AUTORUN_PLAN.md`).
     *
     * A project is several threads — a hub, a design, an architecture, an implementation, a verify —
     * and the auto-run budget was measured on the wrong one. Per thread it either starves a project
     * that legitimately spans five of them, or, raised enough not to, stops being a brake on any
     * single runaway exchange. Naming the hub lets the whole project share one allowance, which is
     * also the number the operator wants to see and raise.
     *
     * Deliberately one level deep: a thread whose hub itself has a hub adopts the outer one, so a
     * chain — and with it a cycle in the budget lookup — cannot be built. `null` is the common case;
     * most of the board is not a project.
     */
    hub_thread_id: { type: Schema.Types.ObjectId, ref: 'ForumThread', default: null },
    /**
     * How many automatic mention runs this thread has spent (`FORUM_PLAN.md` §11.6). The budget it
     * is checked against lives in Settings, so raising the ceiling revives threads that hit the old
     * one instead of stranding them. Lives on the thread rather than being counted from the mention
     * rows because it must survive a post being deleted — otherwise clearing a runaway exchange
     * would hand the same two agents a fresh budget to run it again.
     */
    auto_run_count: { type: Number, default: 0 },
    /**
     * When the current budget window opened. The budget used to be a *lifetime* count, which meant a
     * long-lived thread — a project hub that coordinates for weeks is the intended shape now — spent
     * its last unit one day and then silently stopped waking anyone, with only a log line to say so.
     * A window makes the budget what it was always described as: a brake on a runaway exchange, not
     * a cap on how long a thread may usefully live.
     *
     * Null on a thread that has never auto-replied, and on every thread written before the window
     * existed; both are treated as "the window is stale", so the first claim opens a fresh one.
     */
    auto_run_window_start: { type: Date, default: null },
    /**
     * When the operator was last told this thread ran out of budget. Exhaustion is otherwise a
     * `log.warn` in a container nobody is tailing, which is precisely how a stalled project looks
     * like an idle one. Stamped per window so a busy thread raises one alert, not one per mention.
     */
    auto_run_notified_at: { type: Date, default: null },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'forum_threads' },
);

/** The thread-list query: one category, sticky first, most recently active first. */
ForumThreadSchema.index({ category_id: 1, pinned: -1, last_post_at: -1 });
ForumThreadSchema.index({ status: 1, last_post_at: -1 });
/** "What is open, and who owns it" — the work-queue query. */
ForumThreadSchema.index({ work_state: 1, last_post_at: -1 });
ForumThreadSchema.index({ 'assignee.display_name': 1, work_state: 1 });
/** "Which threads belong to this project?" — the shared-budget lookup and the hub's thread list. */
ForumThreadSchema.index({ hub_thread_id: 1, last_post_at: -1 });
/** Keyword search over titles. Mongo allows one text index per collection — bodies live in `forum_posts`. */
ForumThreadSchema.index({ title: 'text' });

export type ForumThread = InferSchemaType<typeof ForumThreadSchema>;
export type ForumThreadDoc = HydratedDocument<ForumThread>;

export const ForumThreadModel = model('ForumThread', ForumThreadSchema);
