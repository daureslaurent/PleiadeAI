import { createLogger } from '../../config/logger';
import { decryptSecret } from '../../isolation/ssh.service';
import type { MonitorTargetDoc } from './monitor-target.model';
import type { MonitorSnapshot } from './monitor.types';

const log = createLogger('monitor-service');

/**
 * A monitor-client answers in milliseconds on a healthy LAN; its own CPU sample window is ~200ms.
 * Anything past this is a box in trouble (or a wrong URL), and we'd rather mark it offline than let
 * a hung socket stall the whole poll tick.
 */
const TIMEOUT_MS = 8_000;

/** Thrown when a target is unreachable or answers non-2xx. Routes map this to 502. */
export class MonitorTargetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MonitorTargetError';
  }
}

/** Result of one probe: the payload plus how long the round trip took. */
export interface ProbeResult {
  snapshot: MonitorSnapshot;
  latency_ms: number;
}

export const monitorService = {
  /**
   * Fetch `GET /metrics.json` from one target.
   *
   * The key is decrypted here, immediately before the call, and only ever travels backend → target.
   * A malformed stored key is treated as "no key" rather than throwing: an operator who rotated
   * `ENCRYPTION_KEY` should see a clean 401 from the target telling them to re-enter it, not an
   * opaque crypto error from us.
   */
  async probe(target: MonitorTargetDoc): Promise<ProbeResult> {
    const url = `${target.base_url.replace(/\/+$/, '')}/metrics.json`;
    const headers: Record<string, string> = { accept: 'application/json' };

    if (target.api_key_enc) {
      try {
        headers['X-API-Key'] = decryptSecret(target.api_key_enc);
      } catch (err) {
        log.warn({ target: target.name, err }, 'monitor api key could not be decrypted; probing without it');
      }
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // Undici collapses every transport failure into a bare "fetch failed" and hides the real reason
      // (ECONNREFUSED / ENOTFOUND / timeout) on `cause`. Unwrapping it is the difference between an
      // operator seeing "wrong port" and seeing nothing actionable at all.
      const cause = (err as { cause?: unknown })?.cause;
      const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
      const base = err instanceof Error ? err.message : String(err);
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new MonitorTargetError(
        timedOut ? `no response within ${TIMEOUT_MS / 1000}s` : detail || base,
      );
    }

    if (!res.ok) {
      const detail = res.status === 401 ? 'unauthorized — check the API key' : await res.text().catch(() => '');
      throw new MonitorTargetError(`monitor-client returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status);
    }

    const snapshot = (await res.json()) as MonitorSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || !('cpu' in snapshot)) {
      throw new MonitorTargetError('response is not a monitor-client metrics payload');
    }
    return { snapshot, latency_ms: Date.now() - startedAt };
  },
};
