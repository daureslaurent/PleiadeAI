import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { settingsService } from '../settings/settings.service';
import { llamaLogRepository } from '../llama-logs/llama-log.repository';
import { assembleRun } from './turn-assembler';
import { judgeService } from './judge.service';
import { conversationScoreRepository } from './conversation-score.repository';
import type { ConversationScoreDoc } from './conversation-score.model';

const log = createLogger('scoring-service');

export interface BatchOptions {
  /** `unscored` skips runs that already have a score; `rescore` overwrites every run. */
  mode: 'unscored' | 'rescore';
  /** How many runs to judge at once (1 = sequential). Clamped to [1, 16]. */
  concurrency: number;
  /** Cap on runs processed this run (safety valve for a huge archive). */
  limit?: number;
}

export interface BatchResult {
  total: number;
  scored: number;
  skipped: number;
  failed: number;
}

export const scoringService = {
  /**
   * Score one agent-run end-to-end: load its archive records, assemble the transcript + signals, run
   * the judge, and upsert the verdict. Returns the persisted score, or null if the run couldn't be
   * assembled or the judge failed. The scored unit is the agent-run, so a delegated sub-agent is
   * judged on its own conversation rather than folded into the parent's score.
   */
  async scoreRun(runId: string, origin: 'auto' | 'batch' | 'manual'): Promise<ConversationScoreDoc | null> {
    const records = await llamaLogRepository.listByRun(runId);
    const settings = await settingsService.get();
    const run = assembleRun(records, settings.max_tool_iterations);
    if (!run) {
      log.debug({ runId }, 'no archive records for run — nothing to score');
      return null;
    }
    const judged = await judgeService.judge(run);
    if (!judged) {
      log.warn(
        { runId, turnId: run.turnId, agent: run.agentName, depth: run.depth, origin },
        'judge produced no verdict — run left unscored',
      );
      return null;
    }
    const saved = await conversationScoreRepository.upsert({
      runId,
      turnId: run.turnId,
      agentName: run.agentName,
      depth: run.depth,
      sessionId: run.sessionId,
      verdict: judged.verdict,
      judgeModel: judged.judgeModel,
      origin,
    });
    // Notify the turn's chat (live badge on the matching bubble) + the LLM Debug feed.
    eventBus.emit('scoring:turn_scored', {
      sessionId: run.sessionId,
      runId,
      turnId: run.turnId,
      agentName: run.agentName,
      depth: run.depth,
      score: judged.verdict.score,
      tag: judged.verdict.tag,
      explanation: judged.verdict.explanation,
    });
    return saved;
  },

  /**
   * Auto-score hook: when a user-facing turn completes, score EVERY agent-run in it — the top-level
   * agent and each delegated sub-agent — gated on `scoring_enabled`, fire-and-forget. Never throws
   * (scoring must not affect the chat path). Called from AgentRunner after the depth-0 run finishes.
   */
  autoScoreTurn(turnId: string): void {
    void (async () => {
      try {
        const settings = await settingsService.get();
        if (!settings.scoring_enabled) return;
        const runIds = await llamaLogRepository.listRunIdsForTurn(turnId);
        let scored = 0;
        let failed = 0;
        for (const runId of runIds) {
          // Isolate each run: one agent-run that can't be scored must not abort the fan-out and strand
          // the turn's remaining sub-agent runs unscored.
          try {
            if (await this.scoreRun(runId, 'auto')) scored++;
            else failed++;
          } catch (err) {
            failed++;
            log.warn({ turnId, runId, err: err instanceof Error ? err.message : String(err) }, 'auto-score run failed');
          }
        }
        if (failed) log.warn({ turnId, runs: runIds.length, scored, failed }, 'auto-score turn incomplete');
        else log.debug({ turnId, scored }, 'auto-score turn complete');
      } catch (err) {
        log.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'auto-score failed');
      }
    })();
  },

  /**
   * Batch-score agent-runs. Enumerates archive runs (newest first), optionally skips already-scored
   * ones, and judges them with bounded concurrency (1 = sequential, N = parallel). Idempotent in
   * `unscored` mode.
   */
  async scoreAll(opts: BatchOptions): Promise<BatchResult> {
    const concurrency = Math.max(1, Math.min(16, Math.trunc(opts.concurrency) || 1));
    const allRuns = await llamaLogRepository.listRunIds(opts.limit ?? 20000);
    const allRunIds = allRuns.map((r) => r.runId);
    const alreadyScored = opts.mode === 'unscored' ? await conversationScoreRepository.scoredRunIds() : new Set<string>();
    const queue = allRunIds.filter((id) => !alreadyScored.has(id));

    const result: BatchResult = {
      total: allRunIds.length,
      scored: 0,
      skipped: allRunIds.length - queue.length,
      failed: 0,
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const runId = queue[cursor++]!;
        try {
          const scored = await this.scoreRun(runId, 'batch');
          if (scored) result.scored++;
          else result.failed++;
        } catch (err) {
          result.failed++;
          log.warn({ runId, err: err instanceof Error ? err.message : String(err) }, 'batch score failed');
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    log.info({ ...result, mode: opts.mode, concurrency }, 'batch scoring complete');
    return result;
  },
};
