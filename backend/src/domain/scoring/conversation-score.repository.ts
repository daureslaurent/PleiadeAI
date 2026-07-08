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
