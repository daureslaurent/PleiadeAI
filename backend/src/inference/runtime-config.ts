import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('inference-runtime');

/**
 * Hot inference-reliability tunables, mirrored in memory so the hot paths that read them can stay
 * synchronous — {@link import('./endpoint-health').endpointHealth}'s `isAvailable`/`reportFailure`
 * run per candidate on every turn, so they must not hit Mongo. Seeded from env at import, then
 * overwritten by the operator's Settings → Inference values via {@link InferenceRuntimeConfig.apply}
 * (at boot and on every settings save), so a change takes effect without a restart.
 */
export interface InferenceRuntimeValues {
  /** Time-to-first-token budget per attempt (ms) before it's aborted and failover moves on. */
  firstTokenTimeoutMs: number;
  /** How often the background health poller probes every endpoint (ms). */
  healthPollIntervalMs: number;
  /** Consecutive failures before an endpoint is parked as down. */
  healthFailureThreshold: number;
  /** How long a down endpoint stays excluded before one trial request may re-check it (ms). */
  healthCooldownMs: number;
}

class InferenceRuntimeConfig implements InferenceRuntimeValues {
  firstTokenTimeoutMs = env.INFERENCE_FIRST_TOKEN_TIMEOUT_MS;
  healthPollIntervalMs = env.INFERENCE_HEALTH_POLL_INTERVAL_MS;
  healthFailureThreshold = env.INFERENCE_HEALTH_FAILURE_THRESHOLD;
  healthCooldownMs = env.INFERENCE_HEALTH_COOLDOWN_MS;

  /**
   * Adopt the effective (snake_case) settings values. Returns `true` when the poll interval changed,
   * so the caller can re-arm the health poller's timer (the other three are read live at use, so they
   * need no re-arming).
   */
  apply(s: {
    inference_first_token_timeout_ms: number;
    inference_health_poll_interval_ms: number;
    inference_health_failure_threshold: number;
    inference_health_cooldown_ms: number;
  }): boolean {
    const pollChanged = s.inference_health_poll_interval_ms !== this.healthPollIntervalMs;
    this.firstTokenTimeoutMs = s.inference_first_token_timeout_ms;
    this.healthPollIntervalMs = s.inference_health_poll_interval_ms;
    this.healthFailureThreshold = s.inference_health_failure_threshold;
    this.healthCooldownMs = s.inference_health_cooldown_ms;
    log.debug(
      {
        firstTokenTimeoutMs: this.firstTokenTimeoutMs,
        healthPollIntervalMs: this.healthPollIntervalMs,
        healthFailureThreshold: this.healthFailureThreshold,
        healthCooldownMs: this.healthCooldownMs,
      },
      'inference runtime config applied',
    );
    return pollChanged;
  }
}

export const inferenceRuntime = new InferenceRuntimeConfig();
