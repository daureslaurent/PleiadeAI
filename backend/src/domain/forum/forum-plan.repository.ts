import { Types } from 'mongoose';
import { ForumPlanModel, type ForumPlanDoc } from './forum-plan.model';

export const forumPlanRepository = {
  async findById(id: string | Types.ObjectId): Promise<ForumPlanDoc | null> {
    if (!Types.ObjectId.isValid(String(id))) return null;
    return ForumPlanModel.findById(id).exec();
  },

  async findByHub(threadId: string | Types.ObjectId): Promise<ForumPlanDoc | null> {
    if (!Types.ObjectId.isValid(String(threadId))) return null;
    return ForumPlanModel.findOne({ hub_thread_id: threadId }).exec();
  },

  /**
   * The plan a live session is planning.
   *
   * The manager slot is claimed for the length of the planning turn and released when it ends, so
   * this resolves during exactly the window in which `board` `file_task` can be called by a manager
   * — which is what lets the tool bind `plan_id` itself instead of trusting the model to copy an id
   * out of its brief four times running.
   */
  async findByManagerSession(sessionId: string | Types.ObjectId): Promise<ForumPlanDoc | null> {
    if (!Types.ObjectId.isValid(String(sessionId))) return null;
    return ForumPlanModel.findOne({ manager_session_id: sessionId }).exec();
  },

  async create(input: Record<string, unknown>): Promise<ForumPlanDoc> {
    return ForumPlanModel.create({ ...input, created_at: new Date(), updated_at: new Date() });
  },

  async update(id: string | Types.ObjectId, patch: Record<string, unknown>): Promise<ForumPlanDoc | null> {
    return ForumPlanModel.findByIdAndUpdate(id, { $set: { ...patch, updated_at: new Date() } }, { new: true }).exec();
  },

  /** Everything the scheduler may act on. `draft` is excluded by construction — it has not been started. */
  async listRunning(): Promise<ForumPlanDoc[]> {
    return ForumPlanModel.find({ state: { $in: ['running', 'blocked'] } })
      .sort({ last_manager_at: 1 })
      .exec();
  },

  async list(limit = 100): Promise<ForumPlanDoc[]> {
    return ForumPlanModel.find({}).sort({ updated_at: -1 }).limit(limit).exec();
  },

  /**
   * Spend one turn against the plan's allowance, atomically, returning the new total — or null when
   * the plan is out.
   *
   * Claimed *before* the run for the reason `FORUM_PLAN.md` §11.6 established and this design keeps:
   * a turn that dies on an unreachable endpoint still spends its unit, or a failing task retries
   * forever, which is the exact shape a leash exists to stop.
   */
  async claimTurn(id: string | Types.ObjectId): Promise<number | null> {
    const doc = await ForumPlanModel.findOneAndUpdate(
      { _id: id, $expr: { $lt: ['$turns_spent', '$turns_max'] } },
      { $inc: { turns_spent: 1 }, $set: { updated_at: new Date() } },
      { new: true },
    ).exec();
    return doc ? doc.turns_spent : null;
  },

  /** Claim the manager slot, so one tick cannot start two planning turns on one plan. */
  async claimManager(id: string | Types.ObjectId, sessionId: Types.ObjectId): Promise<ForumPlanDoc | null> {
    return ForumPlanModel.findOneAndUpdate(
      { _id: id, manager_session_id: null },
      { $set: { manager_session_id: sessionId, last_manager_at: new Date(), updated_at: new Date() } },
      { new: true },
    ).exec();
  },

  async releaseManager(id: string | Types.ObjectId): Promise<void> {
    await ForumPlanModel.findByIdAndUpdate(id, { $set: { manager_session_id: null } }).exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await ForumPlanModel.deleteOne({ _id: id }).exec();
    return res.deletedCount > 0;
  },
};
