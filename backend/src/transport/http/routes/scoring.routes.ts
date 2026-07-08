import { Router } from 'express';
import { scoringService } from '../../../domain/scoring/scoring.service';
import { exportService } from '../../../domain/scoring/export.service';
import { conversationScoreRepository } from '../../../domain/scoring/conversation-score.repository';
import { llamaLogRepository } from '../../../domain/llama-logs/llama-log.repository';
import { assembleTurn } from '../../../domain/scoring/turn-assembler';
import type { ConversationScoreDoc } from '../../../domain/scoring/conversation-score.model';

/** Conversation Quality Scorer — scores, batch scoring, per-turn inspection, and JSONL export. */
export const scoringRouter = Router();

/** Dataset-health summary: totals + per-tag counts + average score. */
scoringRouter.get('/summary', async (_req, res) => {
  res.json(await conversationScoreRepository.summary());
});

/** List persisted scores, newest first; optional `?tag=` and `?minScore=` filters. */
scoringRouter.get('/scores', async (req, res) => {
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  const minScore = req.query.minScore != null ? Number(req.query.minScore) : undefined;
  const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
  const rows = await conversationScoreRepository.list({ tag, minScore, limit });
  res.json(rows.map(shapeScore));
});

/** One turn's score plus its assembled transcript + signals (for inspecting a ruling). */
scoringRouter.get('/turn/:turnId', async (req, res) => {
  const { turnId } = req.params;
  const [score, records] = await Promise.all([
    conversationScoreRepository.get(turnId),
    llamaLogRepository.listByTurn(turnId),
  ]);
  const turn = assembleTurn(records);
  if (!turn) {
    res.status(404).json({ error: 'no records for turn' });
    return;
  }
  res.json({ score: score ? shapeScore(score) : null, turn });
});

/** Score one turn now (manual). */
scoringRouter.post('/turn/:turnId', async (req, res) => {
  const scored = await scoringService.scoreTurn(req.params.turnId, 'manual');
  if (!scored) {
    res.status(422).json({ error: 'could not score turn (no records or judge failed)' });
    return;
  }
  res.json(shapeScore(scored));
});

/**
 * Batch-score turns. Body: `{ mode: 'unscored'|'rescore', concurrency: number, limit?: number }`.
 * `concurrency: 1` = sequential, >1 = parallel. Runs synchronously and returns the tally.
 */
scoringRouter.post('/score-all', async (req, res) => {
  const mode = req.body?.mode === 'rescore' ? 'rescore' : 'unscored';
  const concurrency = Number(req.body?.concurrency) || 1;
  const limit = req.body?.limit != null ? Number(req.body.limit) : undefined;
  const result = await scoringService.scoreAll({ mode, concurrency, limit });
  res.json(result);
});

/** Write the full archive to a JSONL file on the server (for an external judge / SFT pipeline). */
scoringRouter.post('/export', async (_req, res) => {
  const result = await exportService.exportAll();
  res.json(result);
});

function shapeScore(doc: ConversationScoreDoc) {
  return {
    turnId: doc.turn_id,
    sessionId: doc.session_id ?? null,
    score: doc.score,
    tag: doc.tag,
    explanation: doc.explanation,
    judgeModel: doc.judge_model,
    origin: doc.origin,
    createdAt: doc.created_at,
  };
}
