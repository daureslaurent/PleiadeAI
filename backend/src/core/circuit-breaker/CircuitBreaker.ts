import { createLogger } from '../../config/logger';
import { env } from '../../config/env';

const log = createLogger('circuit-breaker');

export interface CircuitState {
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  /** True once the threshold is hit; the skill is considered disabled. */
  tripped: boolean;
  lastFailureAt?: Date;
  lastError?: string;
}

/**
 * Per-skill circuit breaker (spec §3).
 *
 * Tracks *consecutive* sandbox failures per skill id. When a skill hangs or crashes
 * `SKILL_FAILURE_THRESHOLD` times in a row (default 3), `recordFailure` returns `tripped:true`
 * on the transition — the caller (SkillRunner, Step 5) then marks the skill `disabled` in
 * MongoDB and emits a `system:alert` on the EventBus.
 *
 * State is in-memory: on process restart a tripped skill's `disabled` flag persists in Mongo,
 * so the durable source of truth stays in the database while this guards the hot path.
 */
export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  constructor(private readonly threshold: number = env.SKILL_FAILURE_THRESHOLD) {}

  /** Whether calls to `skillId` should be short-circuited (already tripped). */
  isTripped(skillId: string): boolean {
    return this.states.get(skillId)?.tripped ?? false;
  }

  getState(skillId: string): CircuitState {
    return (
      this.states.get(skillId) ?? { consecutiveFailures: 0, tripped: false }
    );
  }

  /** A clean run resets the consecutive-failure count and closes the circuit. */
  recordSuccess(skillId: string): void {
    const state = this.states.get(skillId);
    if (state && (state.consecutiveFailures > 0 || state.tripped)) {
      log.debug({ skillId }, 'circuit reset after success');
    }
    this.states.set(skillId, { consecutiveFailures: 0, tripped: false });
  }

  /**
   * Record a failed run.
   * @returns `justTripped: true` only on the transition into the tripped state, so the
   *          caller performs the disable + alert side effects exactly once.
   */
  recordFailure(skillId: string, error?: string): { tripped: boolean; justTripped: boolean } {
    const prev = this.getState(skillId);
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const tripped = consecutiveFailures >= this.threshold;
    const justTripped = tripped && !prev.tripped;

    this.states.set(skillId, {
      consecutiveFailures,
      tripped,
      lastFailureAt: new Date(),
      lastError: error,
    });

    if (justTripped) {
      log.error(
        { skillId, consecutiveFailures, threshold: this.threshold },
        'circuit breaker tripped',
      );
    } else {
      log.warn({ skillId, consecutiveFailures, threshold: this.threshold }, 'skill failure recorded');
    }

    return { tripped, justTripped };
  }

  /** Manually clear a skill's circuit (e.g. after an operator re-enables it in the Matrix UI). */
  reset(skillId: string): void {
    this.states.delete(skillId);
    log.info({ skillId }, 'circuit manually reset');
  }
}

/** Process-wide singleton shared by the skill sandbox. */
export const circuitBreaker = new CircuitBreaker();
