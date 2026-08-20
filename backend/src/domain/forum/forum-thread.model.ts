import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/**
 * `open` accepts replies; `locked` is readable but closed (the answer is settled, or the operator
 * stopped a runaway argument); `archived` additionally drops out of the default thread listing.
 */
export const FORUM_THREAD_STATUSES = ['open', 'locked', 'archived'] as const;
export type ForumThreadStatus = (typeof FORUM_THREAD_STATUSES)[number];

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
     * How many automatic mention runs this thread has spent (`FORUM_PLAN.md` §11.6). The budget it
     * is checked against lives in Settings, so raising the ceiling revives threads that hit the old
     * one instead of stranding them. Lives on the thread rather than being counted from the mention
     * rows because it must survive a post being deleted — otherwise clearing a runaway exchange
     * would hand the same two agents a fresh budget to run it again.
     */
    auto_run_count: { type: Number, default: 0 },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'forum_threads' },
);

/** The thread-list query: one category, sticky first, most recently active first. */
ForumThreadSchema.index({ category_id: 1, pinned: -1, last_post_at: -1 });
ForumThreadSchema.index({ status: 1, last_post_at: -1 });
/** Keyword search over titles. Mongo allows one text index per collection — bodies live in `forum_posts`. */
ForumThreadSchema.index({ title: 'text' });

export type ForumThread = InferSchemaType<typeof ForumThreadSchema>;
export type ForumThreadDoc = HydratedDocument<ForumThread>;

export const ForumThreadModel = model('ForumThread', ForumThreadSchema);
