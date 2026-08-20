import { Types } from 'mongoose';
import { ForumPostModel, MAX_EDIT_HISTORY, type ForumPostDoc } from './forum-post.model';
import type { ForumAuthor } from './forum-author';

export interface CreateForumPostInput {
  thread_id: Types.ObjectId | string;
  category_id: Types.ObjectId | string;
  author: ForumAuthor;
  body: string;
  reply_to?: string | null;
  attachments?: Array<Types.ObjectId | string>;
  attachment_names?: string;
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

  /**
   * The newest post an agent wrote on a thread since a given moment — the "did it answer itself?"
   * question a mention run asks before falling back to posting its final text (spec §11.3).
   *
   * Queried rather than tracked off the EventBus on purpose: the agent may post through the `forum`
   * tool from inside a delegated hop or a container, and all of those funnel through `create` here,
   * whereas an in-memory listener only sees what this process happened to be subscribed for.
   */
  latestByAgentSince(threadId: string, agentId: string, since: Date): Promise<ForumPostDoc | null> {
    if (!Types.ObjectId.isValid(threadId) || !Types.ObjectId.isValid(agentId)) return Promise.resolve(null);
    return ForumPostModel.findOne({
      thread_id: threadId,
      'author.agent_id': agentId,
      deleted: false,
      created_at: { $gte: since },
    })
      .sort({ created_at: -1 })
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

  /**
   * The opening post of each of several threads, in one aggregation — the excerpt a thread-reference
   * hovercard shows. Per-thread queries would mean one round trip per `#thread` chip on a page.
   */
  async openingBodies(threadIds: string[]): Promise<Record<string, string>> {
    const valid = threadIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id));
    if (!valid.length) return {};
    const rows = await ForumPostModel.aggregate<{ _id: Types.ObjectId; body: string }>([
      { $match: { thread_id: { $in: valid }, deleted: false } },
      { $sort: { created_at: 1 } },
      { $group: { _id: '$thread_id', body: { $first: '$body' } } },
    ]).exec();
    return Object.fromEntries(rows.map((r) => [String(r._id), r.body]));
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

  /**
   * Apply an edit and push the superseded body onto the post's history in one atomic update.
   *
   * `$push` with `$slice` rather than read-modify-write: a moderator edit and an author edit can land
   * on the same post, and a lost history entry is the one thing that would make an edit unreversible.
   */
  recordEdit(
    id: string,
    patch: Record<string, unknown>,
    previous: { body: string; editor: string; reason: string },
  ): Promise<ForumPostDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumPostModel.findByIdAndUpdate(
      id,
      {
        $set: { ...patch, updated_at: new Date() },
        $push: {
          edits: {
            $each: [{ ...previous, at: new Date() }],
            $slice: -MAX_EDIT_HISTORY,
          },
        },
      },
      { new: true },
    ).exec();
  },

  /**
   * Repoint a whole thread's posts at a new category. Posts carry a denormalised `category_id` so
   * category-scoped search needs no join — which means a move that only updated the thread would
   * leave every post filed under the old category and quietly break that filter.
   */
  async setCategory(threadId: string, categoryId: string): Promise<void> {
    if (!Types.ObjectId.isValid(threadId) || !Types.ObjectId.isValid(categoryId)) return;
    await ForumPostModel.updateMany(
      { thread_id: threadId },
      { $set: { category_id: categoryId, updated_at: new Date() } },
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
