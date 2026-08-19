import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/**
 * `forum_posts` — one message in a thread (spec `FORUM_PLAN.md` §2). Bodies are markdown, rendered
 * by the frontend's existing `Markdown` component.
 *
 * Deletion is **soft**. A thread that quotes or replies to a post has to keep making sense after a
 * moderation action, and an agent that cited `post_id` in a memory shouldn't hit a dangling id.
 */
const ForumPostSchema = new Schema(
  {
    thread_id: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true, index: true },
    /** Denormalised from the thread so category-scoped search can filter without a join. */
    category_id: { type: Schema.Types.ObjectId, ref: 'ForumCategory', required: true, index: true },
    author: { type: ForumAuthorSchema, required: true },
    body: { type: String, required: true },
    /**
     * The post this one answers — the "objection to reply #3" link that makes a debate thread
     * readable. Rendered as a single "in reply to …" line, deliberately *not* as nested threading:
     * a tree is unreadable at 40 posts and impossible to summarise into an agent's context.
     */
    reply_to: { type: Schema.Types.ObjectId, default: null },
    /**
     * Files from the `forum_files` registry hung off this post (spec §10). Ids, not embedded blobs:
     * one artifact can be attached by many posts, and it survives this post being deleted.
     */
    attachments: { type: [{ type: Schema.Types.ObjectId, ref: 'ForumFile' }], default: [] },
    /**
     * Denormalised attachment filenames, kept only so they can join the `$text` index below. A
     * filename is the archetypal exact-string query (`crash-2026-08-19.zip`), which is the half of
     * hybrid search that keyword matching owns — and Mongo allows one text index per collection, so
     * the names have to live on this document to be searchable at all.
     */
    attachment_names: { type: String, default: '' },
    edited_at: { type: Date, default: null },
    edited_by: { type: String, default: '' },
    deleted: { type: Boolean, default: false },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'forum_posts' },
);

/** Reading one thread in order — the single hottest query on the board. */
ForumPostSchema.index({ thread_id: 1, created_at: 1 });
/** Keyword search over bodies + attachment filenames (the exact-string half of hybrid search). */
ForumPostSchema.index({ body: 'text', attachment_names: 'text' }, { weights: { body: 10, attachment_names: 5 } });

export type ForumPost = InferSchemaType<typeof ForumPostSchema>;
export type ForumPostDoc = HydratedDocument<ForumPost>;

export const ForumPostModel = model('ForumPost', ForumPostSchema);
