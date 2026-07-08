import { ConversationScoreModel, type ConversationScoreDoc } from './conversation-score.model';
import type { JudgeVerdict } from './scoring.types';

/** Persistence for Conversation Quality Scorer verdicts (one per agent-run, upserted on re-score). */
export const conversationScoreRepository = {
  /** Insert or overwrite the score for an agent-run. */
  async upsert(input: {
    runId: string;
    turnId: string;
    agentName: string | null;
    depth: number | null;
    sessionId: string | null;
    verdict: JudgeVerdict;
    judgeModel: string;
    origin: 'auto' | 'batch' | 'manual';
  }): Promise<ConversationScoreDoc> {
    const doc = await ConversationScoreModel.findOneAndUpdate(
      { run_id: input.runId },
      {
        $set: {
          turn_id: input.turnId,
          agent_name: input.agentName,
          depth: input.depth,
          session_id: input.sessionId,
          score: input.verdict.score,
          tag: input.verdict.tag,
          explanation: input.verdict.explanation,
          judge_model: input.judgeModel,
          origin: input.origin,
          updated_at: new Date(),
        },
        $setOnInsert: { run_id: input.runId, created_at: new Date() },
      },
      { new: true, upsert: true },
    ).exec();
    return doc;
  },

  get(runId: string): Promise<ConversationScoreDoc | null> {
    return ConversationScoreModel.findOne({ run_id: runId }).exec();
  },

  /**
   * Delete score verdicts by run id. Called when the llama archive is purged: the transcripts the
   * scores derive from are gone, so the verdicts can no longer be inspected, re-scored, or exported —
   * they'd only linger as orphans. With no `runIds` it wipes every score (matches a full archive purge).
   */
  async deleteByRunIds(runIds?: string[]): Promise<number> {
    const filter = runIds ? { run_id: { $in: runIds } } : {};
    const res = await ConversationScoreModel.deleteMany(filter).exec();
    return res.deletedCount ?? 0;
  },

  /** run_ids that already have a score — used to skip them in "unscored only" batch runs. */
  async scoredRunIds(): Promise<Set<string>> {
    const rows = await ConversationScoreModel.find({}, { run_id: 1 }).lean().exec();
    return new Set(rows.map((r) => String(r.run_id)));
  },

  /** List scores, newest first, optionally filtered by session / tag / min score (UI + triage). */
  list(opts: { sessionId?: string; tag?: string; minScore?: number; limit?: number } = {}): Promise<ConversationScoreDoc[]> {
    const filter: Record<string, unknown> = {};
    if (opts.sessionId) filter.session_id = opts.sessionId;
    if (opts.tag) filter.tag = opts.tag;
    if (typeof opts.minScore === 'number') filter.score = { $gte: opts.minScore };
    return ConversationScoreModel.find(filter)
      .sort({ created_at: -1 })
      .limit(opts.limit ?? 200)
      .exec();
  },

  /**
   * run_ids whose verdict passes a quality filter — the eligible training set for a fine-tune.
   * With no constraints this returns every *scored* run (note: still a subset of all runs, since
   * unscored runs have no verdict to judge them by).
   */
  async eligibleRunIds(filter: { minScore?: number; tags?: string[] } = {}): Promise<Set<string>> {
    const q: Record<string, unknown> = {};
    if (typeof filter.minScore === 'number') q.score = { $gte: filter.minScore };
    if (filter.tags?.length) q.tag = { $in: filter.tags };
    const rows = await ConversationScoreModel.find(q, { run_id: 1 }).lean().exec();
    return new Set(rows.map((r) => String(r.run_id)));
  },

  /** How many scored runs pass a quality filter (the "how many examples will train" preview). */
  async countEligible(filter: { minScore?: number; tags?: string[] } = {}): Promise<number> {
    const q: Record<string, unknown> = {};
    if (typeof filter.minScore === 'number') q.score = { $gte: filter.minScore };
    if (filter.tags?.length) q.tag = { $in: filter.tags };
    return ConversationScoreModel.countDocuments(q).exec();
  },

  /** Aggregate counts + average per tag, for a dataset-health summary. */
  async summary(): Promise<{ total: number; avgScore: number; byTag: Record<string, number> }> {
    const rows = await ConversationScoreModel.aggregate<{ _id: string; n: number; avg: number }>([
      { $group: { _id: '$tag', n: { $sum: 1 }, avg: { $avg: '$score' } } },
    ]).exec();
    const byTag: Record<string, number> = {};
    let total = 0;
    let weighted = 0;
    for (const r of rows) {
      byTag[r._id] = r.n;
      total += r.n;
      weighted += r.avg * r.n;
    }
    return { total, avgScore: total ? Math.round(weighted / total) : 0, byTag };
  },
};
