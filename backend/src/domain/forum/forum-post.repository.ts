import { Types } from 'mongoose';
import { ForumPostModel, type ForumPostDoc } from './forum-post.model';
import type { ForumAuthor } from './forum-author';

export interface CreateForumPostInput {
  thread_id: Types.ObjectId | string;
  category_id: Types.ObjectId | string;
  author: ForumAuthor;
  body: string;
  reply_to?: string | null;
}

function clamp(limit: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(limit ?? fallback) || fallback));
}

export const forumPostRepository = {
  /** One page of a thread, oldest first (forums read top-down, unlike a chat log). */
  listByThread(threadId: string, limit?: number, offset = 0): Promise<ForumPostDoc[]> {
    if (!Types.ObjectId.isValid(threadId)) return Promise.resolve([]);
    return ForumPostModel.find({ thread_id: threadId, deleted: false })
      .sort({ created_at: 1 })
      .skip(Math.max(0, Math.trunc(offset) || 0))
      .limit(clamp(limit, 30, 200))
      .exec();
  },

  countByThread(threadId: string): Promise<number> {
    if (!Types.ObjectId.isValid(threadId)) return Promise.resolve(0);
    return ForumPostModel.countDocuments({ thread_id: threadId, deleted: false }).exec();
  },

  /** Post counts for a set of authors, in one aggregation — the "1,204 posts" line under an avatar. */
  async countsByAuthor(displayNames: string[]): Promise<Record<string, number>> {
    if (!displayNames.length) return {};
    const rows = await ForumPostModel.aggregate<{ _id: string; n: number }>([
      { $match: { 'author.display_name': { $in: displayNames }, deleted: false } },
      { $group: { _id: '$author.display_name', n: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  },

  findById(id: string): Promise<ForumPostDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumPostModel.findById(id).exec();
  },

  /** The keyword half of hybrid search: Mongo `$text` over post bodies. */
  searchByText(query: string, categoryId: string | undefined, limit: number): Promise<ForumPostDoc[]> {
    const filter: Record<string, unknown> = { $text: { $search: query }, deleted: false };
    if (categoryId && Types.ObjectId.isValid(categoryId)) filter.category_id = categoryId;
    // MongoDB ≥4.4 ranks by text score without it being projected, which keeps the query typed.
    return ForumPostModel.find(filter)
      .sort({ score: { $meta: 'textScore' } })
      .limit(clamp(limit, 10, 50))
      .exec();
  },

  create(input: CreateForumPostInput): Promise<ForumPostDoc> {
    return ForumPostModel.create({ ...input, reply_to: input.reply_to || null });
  },

  update(id: string, patch: Record<string, unknown>): Promise<ForumPostDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumPostModel.findByIdAndUpdate(
      id,
      { $set: { ...patch, updated_at: new Date() } },
      { new: true },
    ).exec();
  },

  /** Soft delete — see the model's JSDoc for why the document survives. */
  async softDelete(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await ForumPostModel.findByIdAndUpdate(id, { $set: { deleted: true } }, { new: true }).exec();
    return Boolean(res);
  },

  /** Hard removal of a whole thread's posts, used when the operator deletes the thread itself. */
  async removeByThread(threadId: string): Promise<string[]> {
    if (!Types.ObjectId.isValid(threadId)) return [];
    const posts = await ForumPostModel.find({ thread_id: threadId }, { _id: 1 }).lean().exec();
    await ForumPostModel.deleteMany({ thread_id: threadId }).exec();
    return posts.map((p) => String(p._id));
  },
};
