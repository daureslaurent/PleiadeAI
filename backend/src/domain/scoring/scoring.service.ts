import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { settingsService } from '../settings/settings.service';
import { llamaLogRepository } from '../llama-logs/llama-log.repository';
import { assembleTurn } from './turn-assembler';
import { judgeService } from './judge.service';
import { conversationScoreRepository } from './conversation-score.repository';
import type { ConversationScoreDoc } from './conversation-score.model';

const log = createLogger('scoring-service');

export interface BatchOptions {
  /** `unscored` skips turns that already have a score; `rescore` overwrites every turn. */
  mode: 'unscored' | 'rescore';
  /** How many turns to judge at once (1 = sequential). Clamped to [1, 16]. */
  concurrency: number;
  /** Cap on turns processed this run (safety valve for a huge archive). */
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
   * Score one turn end-to-end: load its archive records, assemble the transcript + signals, run the
   * judge, and upsert the verdict. Returns the persisted score, or null if the turn couldn't be
   * assembled or the judge failed.
   */
  async scoreTurn(turnId: string, origin: 'auto' | 'batch' | 'manual'): Promise<ConversationScoreDoc | null> {
    const records = await llamaLogRepository.listByTurn(turnId);
    const turn = assembleTurn(records);
    if (!turn) {
      log.debug({ turnId }, 'no archive records for turn — nothing to score');
      return null;
    }
    const judged = await judgeService.judge(turn);
    if (!judged) return null;
    const saved = await conversationScoreRepository.upsert({
      turnId,
      sessionId: turn.sessionId,
      verdict: judged.verdict,
      judgeModel: judged.judgeModel,
      origin,
    });
    // Notify the turn's chat (live badge) + the LLM Debug feed.
    eventBus.emit('scoring:turn_scored', {
      sessionId: turn.sessionId,
      turnId,
      score: judged.verdict.score,
      tag: judged.verdict.tag,
      explanation: judged.verdict.explanation,
    });
    return saved;
  },

  /**
   * Auto-score hook: fire-and-forget scoring of a just-completed turn, gated on the `scoring_enabled`
   * setting. Never throws — scoring must not affect the chat path. Called from AgentRunner after a
   * top-level (depth-0) run finishes.
   */
  autoScore(turnId: string): void {
    void (async () => {
      try {
        const settings = await settingsService.get();
        if (!settings.scoring_enabled) return;
        await this.scoreTurn(turnId, 'auto');
      } catch (err) {
        log.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'auto-score failed');
      }
    })();
  },

  /**
   * Batch-score turns. Enumerates archive turns (newest first), optionally skips already-scored ones,
   * and judges them with bounded concurrency (1 = sequential, N = parallel). Idempotent in `unscored`
   * mode.
   */
  async scoreAll(opts: BatchOptions): Promise<BatchResult> {
    const concurrency = Math.max(1, Math.min(16, Math.trunc(opts.concurrency) || 1));
    const allTurnIds = await llamaLogRepository.listTurnIds(opts.limit ?? 5000);
    const alreadyScored = opts.mode === 'unscored' ? await conversationScoreRepository.scoredTurnIds() : new Set<string>();
    const queue = allTurnIds.filter((id) => !alreadyScored.has(id));

    const result: BatchResult = {
      total: allTurnIds.length,
      scored: 0,
      skipped: allTurnIds.length - queue.length,
      failed: 0,
    };

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const turnId = queue[cursor++]!;
        try {
          const scored = await this.scoreTurn(turnId, 'batch');
          if (scored) result.scored++;
          else result.failed++;
        } catch (err) {
          result.failed++;
          log.warn({ turnId, err: err instanceof Error ? err.message : String(err) }, 'batch score failed');
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    log.info({ ...result, mode: opts.mode, concurrency }, 'batch scoring complete');
    return result;
  },
};
