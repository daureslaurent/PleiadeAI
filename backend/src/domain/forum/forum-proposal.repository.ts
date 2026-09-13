import { Types } from 'mongoose';
import { ForumProposalModel, type ForumProposalDoc } from './forum-proposal.model';

export const forumProposalRepository = {
  async findById(id: string | Types.ObjectId): Promise<ForumProposalDoc | null> {
    if (!Types.ObjectId.isValid(String(id))) return null;
    return ForumProposalModel.findById(id).exec();
  },

  /**
   * File a proposal, superseding whatever was still pending on the plan. One live proposal at a time:
   * two open change sets written against two different snapshots of the same graph can each be
   * valid and still contradict each other once both are applied.
   */
  async create(input: Record<string, unknown> & { plan_id: Types.ObjectId }): Promise<ForumProposalDoc> {
    await ForumProposalModel.updateMany(
      { plan_id: input.plan_id, state: 'pending' },
      { $set: { state: 'superseded', decided_at: new Date() } },
    ).exec();
    return ForumProposalModel.create({ ...input, state: 'pending', created_at: new Date() });
  },

  async listByPlan(planId: string | Types.ObjectId, limit = 20): Promise<ForumProposalDoc[]> {
    if (!Types.ObjectId.isValid(String(planId))) return [];
    return ForumProposalModel.find({ plan_id: planId }).sort({ created_at: -1 }).limit(limit).exec();
  },

  async latest(planId: string | Types.ObjectId): Promise<ForumProposalDoc | null> {
    if (!Types.ObjectId.isValid(String(planId))) return null;
    return ForumProposalModel.findOne({ plan_id: planId }).sort({ created_at: -1 }).exec();
  },

  async pendingPlanIds(): Promise<Set<string>> {
    const ids = await ForumProposalModel.distinct('plan_id', { state: 'pending' }).exec();
    return new Set(ids.map(String));
  },

  async save(doc: ForumProposalDoc): Promise<ForumProposalDoc> {
    doc.markModified('ops');
    return doc.save();
  },

  async removeByPlan(planId: string | Types.ObjectId): Promise<void> {
    await ForumProposalModel.deleteMany({ plan_id: planId }).exec();
  },
};
