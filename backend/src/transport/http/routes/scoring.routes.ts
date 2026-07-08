import { Router } from 'express';
import { scoringService } from '../../../domain/scoring/scoring.service';
import { exportService } from '../../../domain/scoring/export.service';
import { conversationScoreRepository } from '../../../domain/scoring/conversation-score.repository';
import { llamaLogRepository } from '../../../domain/llama-logs/llama-log.repository';
import { assembleRun } from '../../../domain/scoring/turn-assembler';
import type { ConversationScoreDoc } from '../../../domain/scoring/conversation-score.model';

/** Conversation Quality Scorer — scores, batch scoring, per-turn inspection, and JSONL export. */
export const scoringRouter = Router();

/** Dataset-health summary: totals + per-tag counts + average score. */
scoringRouter.get('/summary', async (_req, res) => {
  res.json(await conversationScoreRepository.summary());
});

/**
 * Training-dataset composition, for the Fine-Tuning page's chart + "how many examples will train"
 * preview. `total_examples` counts every exportable agent-run (scored or not); `scored` is the
 * quality distribution of the judged subset; `filtered_count` is how many pass the supplied filter.
 * Optional `?minScore=` and `?tags=Perfect,Patched`.
 */
scoringRouter.get('/dataset-stats', async (req, res) => {
  const minScore = req.query.minScore != null ? Number(req.query.minScore) : undefined;
  const tags =
    typeof req.query.tags === 'string' && req.query.tags.trim()
      ? req.query.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
  const filter = { minScore: Number.isFinite(minScore) ? minScore : undefined, tags };

  const [runs, scored, filteredCount] = await Promise.all([
    // Cheap: count run ids rather than reassembling every example (buildJsonl is expensive).
    llamaLogRepository.listRunIds(),
    conversationScoreRepository.summary(),
    conversationScoreRepository.countEligible(filter),
  ]);

  res.json({
    total_examples: runs.length,
    scored,
    filtered_count: filteredCount,
    filter: { minScore: filter.minScore ?? null, tags: tags ?? null },
  });
});

/** List persisted scores, newest first; optional `?sessionId=`, `?tag=`, `?minScore=` filters. */
scoringRouter.get('/scores', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
  const minScore = req.query.minScore != null ? Number(req.query.minScore) : undefined;
  const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
  const rows = await conversationScoreRepository.list({ sessionId, tag, minScore, limit });
  res.json(rows.map(shapeScore));
});

/** One run's score plus its assembled transcript + signals (for inspecting a ruling). */
scoringRouter.get('/run/:runId', async (req, res) => {
  const { runId } = req.params;
  const [score, records] = await Promise.all([
    conversationScoreRepository.get(runId),
    llamaLogRepository.listByRun(runId),
  ]);
  const run = assembleRun(records);
  if (!run) {
    res.status(404).json({ error: 'no records for run' });
    return;
  }
  res.json({ score: score ? shapeScore(score) : null, run });
});

/** Score one run now (manual). */
scoringRouter.post('/run/:runId', async (req, res) => {
  const scored = await scoringService.scoreRun(req.params.runId, 'manual');
  if (!scored) {
    res.status(422).json({ error: 'could not score run (no records or judge failed)' });
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

/**
 * Download the JSONL export: writes the server-side file (as `/export` does) AND streams the same
 * content back as a file attachment, so the operator gets the dump locally in one click.
 */
scoringRouter.get('/export/download', async (_req, res) => {
  const { body, turns } = await exportService.buildJsonl();
  // Persist the server copy (fire-and-forget) so both delivery modes stay in sync.
  void exportService.writeFile(body, turns).catch(() => undefined);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', `attachment; filename="sft-export-${stamp}.jsonl"`);
  res.send(body);
});

function shapeScore(doc: ConversationScoreDoc) {
  return {
    runId: doc.run_id,
    turnId: doc.turn_id ?? null,
    agentName: doc.agent_name ?? null,
    depth: doc.depth ?? null,
    sessionId: doc.session_id ?? null,
    score: doc.score,
    tag: doc.tag,
    explanation: doc.explanation,
    judgeModel: doc.judge_model,
    origin: doc.origin,
    createdAt: doc.created_at,
  };
}
