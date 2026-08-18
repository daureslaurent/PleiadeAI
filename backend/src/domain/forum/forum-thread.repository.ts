import { Types } from 'mongoose';
import { ForumThreadModel, type ForumThreadDoc } from './forum-thread.model';
import type { ForumAuthor } from './forum-author';

export interface CreateForumThreadInput {
  category_id: Types.ObjectId | string;
  title: string;
  author: ForumAuthor;
  tags?: string[];
}

export interface ListThreadsOptions {
  categoryId?: string;
  /** Archived threads are hidden unless asked for. */
  includeArchived?: boolean;
  limit?: number;
}

/** Clamp any caller-supplied page size — an agent asking for 10_000 threads must not get them. */
function clamp(limit: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.trunc(limit ?? fallback) || fallback));
}

export const forumThreadRepository = {
  list(opts: ListThreadsOptions = {}): Promise<ForumThreadDoc[]> {
    const filter: Record<string, unknown> = {};
    if (opts.categoryId && Types.ObjectId.isValid(opts.categoryId)) filter.category_id = opts.categoryId;
    if (!opts.includeArchived) filter.status = { $ne: 'archived' };
    return ForumThreadModel.find(filter)
      .sort({ pinned: -1, last_post_at: -1 })
      .limit(clamp(opts.limit, 50, 200))
      .exec();
  },

  findById(id: string): Promise<ForumThreadDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumThreadModel.findById(id).exec();
  },

  findByIds(ids: string[]): Promise<ForumThreadDoc[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return Promise.resolve([]);
    return ForumThreadModel.find({ _id: { $in: valid } }).exec();
  },

  /** The keyword half of hybrid search: Mongo `$text` over thread titles. */
  searchByText(query: string, categoryId: string | undefined, limit: number): Promise<ForumThreadDoc[]> {
    const filter: Record<string, unknown> = { $text: { $search: query } };
    if (categoryId && Types.ObjectId.isValid(categoryId)) filter.category_id = categoryId;
    // MongoDB ≥4.4 ranks by text score without it being projected, which keeps the query typed.
    return ForumThreadModel.find(filter)
      .sort({ score: { $meta: 'textScore' } })
      .limit(clamp(limit, 10, 50))
      .exec();
  },

  create(input: CreateForumThreadInput): Promise<ForumThreadDoc> {
    return ForumThreadModel.create({
      ...input,
      last_post_at: new Date(),
      last_post_author: input.author.display_name,
    });
  },

  update(id: string, patch: Record<string, unknown>): Promise<ForumThreadDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumThreadModel.findByIdAndUpdate(
      id,
      { $set: { ...patch, updated_at: new Date() } },
      { new: true },
    ).exec();
  },

  /**
   * Record a new reply on the thread in one atomic operation. `$inc` rather than read-modify-write
   * because two agents can be mid-turn on the same thread and a lost update would show the wrong
   * reply count forever.
   */
  registerPost(id: Types.ObjectId | string, authorName: string, at: Date): Promise<ForumThreadDoc | null> {
    return ForumThreadModel.findByIdAndUpdate(
      id,
      { $inc: { post_count: 1 }, $set: { last_post_at: at, last_post_author: authorName, updated_at: at } },
      { new: true },
    ).exec();
  },

  incrementViews(id: string): Promise<unknown> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumThreadModel.updateOne({ _id: id }, { $inc: { view_count: 1 } }).exec();
  },

  countByCategory(categoryId: Types.ObjectId | string): Promise<number> {
    return ForumThreadModel.countDocuments({ category_id: categoryId }).exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    return Boolean(await ForumThreadModel.findByIdAndDelete(id).exec());
  },
};
