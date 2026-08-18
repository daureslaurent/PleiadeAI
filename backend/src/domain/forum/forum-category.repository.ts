import { Types } from 'mongoose';
import { ForumCategoryModel, slugify, type ForumCategoryDoc } from './forum-category.model';

export interface CreateForumCategoryInput {
  name: string;
  description?: string;
  position?: number;
  agents_can_post?: boolean;
}

/** Data-access for forum categories. Thin — posting rules live in `forum.service.ts`. */
export const forumCategoryRepository = {
  list(): Promise<ForumCategoryDoc[]> {
    return ForumCategoryModel.find({}).sort({ position: 1, name: 1 }).exec();
  },

  /** Categories the agent-facing tool is allowed to see. */
  listEnabled(): Promise<ForumCategoryDoc[]> {
    return ForumCategoryModel.find({ enabled: true }).sort({ position: 1, name: 1 }).exec();
  },

  findById(id: string): Promise<ForumCategoryDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumCategoryModel.findById(id).exec();
  },

  /**
   * Resolve by id, slug *or* name — the `forum` tool addresses categories the way a model naturally
   * writes them ("Knowledge Base"), the UI by id. Name matching is case-insensitive but anchored, so
   * "general" can't accidentally select "General Discussion Archive".
   */
  async findByIdOrName(idOrName: string): Promise<ForumCategoryDoc | null> {
    const byId = await this.findById(idOrName);
    if (byId) return byId;
    const slug = slugify(idOrName);
    return ForumCategoryModel.findOne({ $or: [{ slug }, { slug: idOrName }] }).exec();
  },

  create(input: CreateForumCategoryInput): Promise<ForumCategoryDoc> {
    return ForumCategoryModel.create({ ...input, slug: slugify(input.name) });
  },

  update(id: string, patch: Record<string, unknown>): Promise<ForumCategoryDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    const next = { ...patch };
    if (typeof next.name === 'string') next.slug = slugify(next.name);
    return ForumCategoryModel.findByIdAndUpdate(
      id,
      { $set: { ...next, updated_at: new Date() } },
      { new: true },
    ).exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    return Boolean(await ForumCategoryModel.findByIdAndDelete(id).exec());
  },
};
