import { Types } from 'mongoose';
import { ForumTaskModel, type ForumTaskDoc, type ForumTaskState } from './forum-task.model';

/** States a task can be dispatched *out of*. Everything else is either running, finished or parked. */
export const DISPATCHABLE: ForumTaskState[] = ['todo', 'review'];

export const forumTaskRepository = {
  async findById(id: string | Types.ObjectId): Promise<ForumTaskDoc | null> {
    if (!Types.ObjectId.isValid(String(id))) return null;
    return ForumTaskModel.findById(id).exec();
  },

  async findByThread(threadId: string | Types.ObjectId): Promise<ForumTaskDoc | null> {
    if (!Types.ObjectId.isValid(String(threadId))) return null;
    return ForumTaskModel.findOne({ thread_id: threadId }).exec();
  },

  async findMany(ids: Array<string | Types.ObjectId>): Promise<ForumTaskDoc[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(String(id)));
    if (!valid.length) return [];
    return ForumTaskModel.find({ _id: { $in: valid } }).exec();
  },

  async create(input: Record<string, unknown>): Promise<ForumTaskDoc> {
    return ForumTaskModel.create({ ...input, created_at: new Date(), updated_at: new Date() });
  },

  async update(id: string | Types.ObjectId, patch: Record<string, unknown>): Promise<ForumTaskDoc | null> {
    return ForumTaskModel.findByIdAndUpdate(id, { $set: { ...patch, updated_at: new Date() } }, { new: true }).exec();
  },

  /** Every task in a plan, in filing order — the plan page, and what the manager is shown. */
  async listByPlan(planId: string | Types.ObjectId): Promise<ForumTaskDoc[]> {
    return ForumTaskModel.find({ plan_id: planId }).sort({ created_at: 1 }).exec();
  },

  /**
   * The scheduler's candidates for one plan: everything not finished, reviews first.
   *
   * Reviews outrank work *always* (spec §5.3). Work already done and waiting on a signature is the
   * cheapest thing on the board to convert into progress, and a review backlog is precisely what
   * makes a finished plan look stalled.
   */
  async pending(planId: string | Types.ObjectId): Promise<ForumTaskDoc[]> {
    return ForumTaskModel.find({
      plan_id: planId,
      state: { $in: ['todo', 'doing', 'review', 'blocked'] },
    })
      .sort({ created_at: 1 })
      .exec();
  },

  /** Standalone tasks — filed without a plan, and dispatched by the same tick. */
  async pendingStandalone(): Promise<ForumTaskDoc[]> {
    return ForumTaskModel.find({ plan_id: null, state: { $in: ['todo', 'review'] } })
      .sort({ created_at: 1 })
      .exec();
  },

  /** Everything currently dispatched, fleet-wide. The parallelism check and the reaper's input. */
  async inFlight(): Promise<ForumTaskDoc[]> {
    return ForumTaskModel.find({ 'dispatch.session_id': { $ne: null } }).exec();
  },

  /**
   * Claim a task for a dispatch, atomically.
   *
   * Conditional on `dispatch.session_id` still being null, so two ticks — or a tick racing the
   * operator's manual dispatch — cannot both start a turn on one task. This is the one write in the
   * scheduler that must not lose a race: everything else it does is idempotent.
   */
  async claimDispatch(
    id: string | Types.ObjectId,
    sessionId: Types.ObjectId,
    kind: 'work' | 'review',
    nextState: ForumTaskState,
  ): Promise<ForumTaskDoc | null> {
    return ForumTaskModel.findOneAndUpdate(
      { _id: id, 'dispatch.session_id': null },
      {
        $set: {
          state: nextState,
          'dispatch.session_id': sessionId,
          'dispatch.at': new Date(),
          'dispatch.kind': kind,
          updated_at: new Date(),
        },
        $inc: { 'dispatch.count': 1 },
      },
      { new: true },
    ).exec();
  },

  /** Release an in-flight claim — the run finished, one way or another. */
  async releaseDispatch(id: string | Types.ObjectId, state?: ForumTaskState): Promise<ForumTaskDoc | null> {
    const set: Record<string, unknown> = {
      'dispatch.session_id': null,
      'dispatch.kind': null,
      updated_at: new Date(),
    };
    if (state) set.state = state;
    return ForumTaskModel.findByIdAndUpdate(id, { $set: set }, { new: true }).exec();
  },

  /** One agent's open work — the prompt block (spec §8) and the agent's own page. */
  async listForAgent(agentId: string): Promise<{ owned: ForumTaskDoc[]; reviewing: ForumTaskDoc[] }> {
    const [owned, reviewing] = await Promise.all([
      ForumTaskModel.find({ 'owner.agent_id': agentId, state: { $in: ['todo', 'doing', 'blocked'] } })
        .sort({ updated_at: -1 })
        .limit(6)
        .exec(),
      ForumTaskModel.find({ 'reviewer.agent_id': agentId, state: 'review' })
        .sort({ updated_at: -1 })
        .limit(6)
        .exec(),
    ]);
    return { owned, reviewing };
  },

  /** The board page: everything open, newest activity first. */
  async listOpen(limit = 100): Promise<ForumTaskDoc[]> {
    return ForumTaskModel.find({ state: { $nin: ['done', 'cancelled'] } })
      .sort({ updated_at: -1 })
      .limit(limit)
      .exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await ForumTaskModel.deleteOne({ _id: id }).exec();
    return res.deletedCount > 0;
  },
};
