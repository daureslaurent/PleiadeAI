import { Types } from 'mongoose';
import {
  ForumMentionModel,
  type ForumMentionDoc,
  type ForumMentionStatus,
  type ForumSummonBlock,
} from './forum-mention.model';
import type { ForumAuthor } from './forum-author';

export interface CreateForumMentionInput {
  post_id: Types.ObjectId | string;
  thread_id: Types.ObjectId | string;
  category_id: Types.ObjectId | string;
  thread_title: string;
  excerpt: string;
  target: ForumAuthor;
  author: ForumAuthor;
  notified: boolean;
  /** Whether this asks for a turn or merely addresses somebody (spec §11.7). */
  summon: boolean;
  /** Which guard withheld it from the auto-reply queue, if one did. */
  run_blocked: ForumSummonBlock | null;
  /** How many agent-to-agent summonses deep this sits. See `SummonContext`. */
  chain_depth: number;
}

export const forumMentionRepository = {
  /**
   * One post can address several people at once. `create` with an array rather than `insertMany` so
   * the caller gets back hydrated documents — it needs their ids to emit and to alert on.
   */
  createMany(rows: CreateForumMentionInput[]): Promise<ForumMentionDoc[]> {
    return rows.length ? Promise.all(rows.map((row) => ForumMentionModel.create(row))) : Promise.resolve([]);
  },

  findById(id: string): Promise<ForumMentionDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumMentionModel.findById(id).exec();
  },

  /**
   * The triage query behind `/forum/mentions`, the agent page queue and the sidebar badge — one
   * shape covering all three, narrowed by whichever of the filters the caller supplies.
   */
  list(opts: {
    status?: ForumMentionStatus | 'all';
    agentId?: string;
    /** `true` → only the operator's own mentions, the `@Operator` inbox. */
    operator?: boolean;
    threadId?: string;
    limit?: number;
  } = {}): Promise<ForumMentionDoc[]> {
    const filter: Record<string, unknown> = {};
    if (opts.status && opts.status !== 'all') filter.status = opts.status;
    if (opts.agentId) filter['target.agent_id'] = opts.agentId;
    if (opts.operator) filter['target.kind'] = 'operator';
    if (opts.threadId && Types.ObjectId.isValid(opts.threadId)) filter.thread_id = opts.threadId;
    return ForumMentionModel.find(filter)
      .sort({ created_at: -1 })
      .limit(Math.max(1, Math.min(200, opts.limit ?? 100)))
      .exec();
  },

  /** Mentions on a set of posts — how a thread page paints its chips without a query per post. */
  listByPosts(postIds: Array<Types.ObjectId | string>): Promise<ForumMentionDoc[]> {
    const ids = postIds.map(String).filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return Promise.resolve([]);
    return ForumMentionModel.find({ post_id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).exec();
  },

  /**
   * How many times `authorAgentId` has summoned `targetAgentId` on this thread since `since` — the
   * direct-ping-pong signature, counted by name rather than by volume.
   *
   * The per-thread budget cannot see this: twenty runs spread over five agents relaying work is a
   * project moving, and twenty runs between two agents is a loop. Only summonses count; being
   * addressed was never going to run anything.
   */
  countPair(threadId: string, authorAgentId: string, targetAgentId: string, since: Date | null): Promise<number> {
    if (!Types.ObjectId.isValid(threadId)) return Promise.resolve(0);
    const filter: Record<string, unknown> = {
      thread_id: new Types.ObjectId(threadId),
      'author.agent_id': authorAgentId,
      'target.agent_id': targetAgentId,
      summon: true,
    };
    if (since) filter.created_at = { $gte: since };
    return ForumMentionModel.countDocuments(filter).exec();
  },

  countPending(agentId?: string): Promise<number> {
    const filter: Record<string, unknown> = { status: 'pending' };
    if (agentId) filter['target.agent_id'] = agentId;
    return ForumMentionModel.countDocuments(filter).exec();
  },

  /** Pending counts for every agent at once — the Agents page badges, in one aggregation. */
  async pendingByAgent(): Promise<Record<string, number>> {
    const rows = await ForumMentionModel.aggregate<{ _id: string | null; n: number }>([
      { $match: { status: 'pending', 'target.kind': 'agent' } },
      { $group: { _id: '$target.agent_id', n: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(rows.filter((r) => r._id).map((r) => [String(r._id), r.n]));
  },

  update(id: string | Types.ObjectId, patch: Record<string, unknown>): Promise<ForumMentionDoc | null> {
    return ForumMentionModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  /** A deleted post's mentions go with it — a queue entry pointing at nothing is pure noise. */
  async removeByPost(postId: string): Promise<void> {
    if (!Types.ObjectId.isValid(postId)) return;
    await ForumMentionModel.deleteMany({ post_id: postId }).exec();
  },

  async removeByThread(threadId: string): Promise<void> {
    if (!Types.ObjectId.isValid(threadId)) return;
    await ForumMentionModel.deleteMany({ thread_id: threadId }).exec();
  },
};
