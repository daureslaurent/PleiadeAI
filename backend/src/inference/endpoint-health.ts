import { createLogger } from '../config/logger';
import { endpointRepository } from '../domain/endpoints/endpoint.repository';
import { inferenceRuntime } from './runtime-config';

const log = createLogger('endpoint-health');

/**
 * In-memory reachability circuit-breaker for inference endpoints, consulted by {@link LlamaClient}
 * so a chat turn never routes to (and waits on) a box already known to be down.
 *
 * Two feeds keep it fresh: a background poller (`start`) that probes every endpoint's `/v1/models`
 * on {@link env.INFERENCE_HEALTH_POLL_INTERVAL_MS}, and reactive reports from live inference calls
 * (`reportSuccess` / `reportFailure`). An endpoint is parked *down* after
 * {@link env.INFERENCE_HEALTH_FAILURE_THRESHOLD} consecutive failures; while down it is excluded from
 * routing until {@link env.INFERENCE_HEALTH_COOLDOWN_MS} elapses, after which one trial request is let
 * through (half-open) so recovery self-heals even if the poller is lagging. Any single success clears
 * it straight back to up.
 *
 * State is per backend process (reset on restart) — the normal shape for a circuit breaker; there is
 * nothing to persist since it's derived live from whether the box answers.
 */

/** Probe timeout for the background poll — a dead box shouldn't hold the poll cycle open. */
const PROBE_TIMEOUT_MS = 3500;

const norm = (url: string): string => url.replace(/\/$/, '');

interface HealthEntry {
  /** Consecutive failures since the last success. */
  failures: number;
  /** When the endpoint crossed the threshold into "down", or null while it's considered up. */
  downSince: number | null;
  /** Last time a trial request was allowed through while down (rate-limits the half-open probe). */
  lastTrialAt: number | null;
  lastError?: string;
}

class EndpointHealth {
  private entries = new Map<string, HealthEntry>();
  private timer: NodeJS.Timeout | null = null;

  private entry(url: string): HealthEntry {
    let e = this.entries.get(url);
    if (!e) {
      e = { failures: 0, downSince: null, lastTrialAt: null };
      this.entries.set(url, e);
    }
    return e;
  }

  /**
   * Whether routing may use this endpoint right now. True unless it's parked down and still inside the
   * cooldown. Once the cooldown elapses on a down endpoint, returns true for a *single* trial request
   * (recording the attempt) so a recovered box is rediscovered even without the poller.
   */
  isAvailable(rawUrl: string): boolean {
    const url = norm(rawUrl);
    const e = this.entries.get(url);
    if (!e || e.downSince === null) return true;
    const now = Date.now();
    const cooldown = inferenceRuntime.healthCooldownMs;
    // Down and past cooldown: allow one trial through, but not repeatedly — space trials by the
    // cooldown so concurrent turns don't all pile onto a still-dead box.
    if (now - e.downSince >= cooldown) {
      if (e.lastTrialAt === null || now - e.lastTrialAt >= cooldown) {
        e.lastTrialAt = now;
        return true;
      }
    }
    return false;
  }

  /** A call (or poll) to this endpoint succeeded: clear all failure state back to up. */
  reportSuccess(rawUrl: string): void {
    const url = norm(rawUrl);
    const e = this.entries.get(url);
    if (!e) return;
    if (e.downSince !== null) log.info({ url }, 'endpoint recovered — back in rotation');
    e.failures = 0;
    e.downSince = null;
    e.lastTrialAt = null;
    e.lastError = undefined;
  }

  /** A call (or poll) to this endpoint failed: increment, and park it down at the threshold. */
  reportFailure(rawUrl: string, error?: string): void {
    const url = norm(rawUrl);
    const e = this.entry(url);
    e.failures++;
    e.lastError = error;
    if (e.downSince === null && e.failures >= inferenceRuntime.healthFailureThreshold) {
      e.downSince = Date.now();
      log.warn({ url, failures: e.failures, error }, 'endpoint marked down — excluded from routing');
    }
  }

  /** Probe one endpoint's `/v1/models` and fold the result into the breaker state. */
  private async probe(baseUrl: string, apiKey: string): Promise<void> {
    try {
      const res = await fetch(`${norm(baseUrl)}/v1/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (res.ok) this.reportSuccess(baseUrl);
      else this.reportFailure(baseUrl, `HTTP ${res.status}`);
    } catch (err) {
      this.reportFailure(baseUrl, err instanceof Error ? err.message : String(err));
    }
  }

  /** One poll sweep over every configured endpoint. Best-effort; never throws. */
  async pollOnce(): Promise<void> {
    try {
      const endpoints = await endpointRepository.list();
      await Promise.all(endpoints.map((ep) => this.probe(ep.base_url, ep.api_key)));
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, 'health poll sweep failed');
    }
  }

  /** Start the background poller. Called once at boot alongside the other pollers in `index.ts`. */
  start(): void {
    if (this.timer) return;
    this.arm();
    log.info({ intervalMs: inferenceRuntime.healthPollIntervalMs }, 'endpoint health poller armed');
    // Prime the state immediately so the first chat turn after boot already has fresh readings.
    void this.pollOnce();
  }

  /** (Re)create the interval timer at the currently-configured poll interval. */
  private arm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.pollOnce(), inferenceRuntime.healthPollIntervalMs);
    // Don't keep the event loop alive just for the health poll (mirrors the monitor poller).
    this.timer.unref?.();
  }

  /**
   * Re-arm the timer to pick up a changed poll interval (called from the settings route after
   * {@link inferenceRuntime.apply} reports the interval moved). No-op if the poller isn't running yet.
   */
  rearm(): void {
    if (!this.timer) return;
    this.arm();
    log.info({ intervalMs: inferenceRuntime.healthPollIntervalMs }, 'endpoint health poller re-armed');
  }
}

export const endpointHealth = new EndpointHealth();
