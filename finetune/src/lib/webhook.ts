import type { WebhookPayload } from '../types';
import { createLogger } from '../config/logger';

const log = createLogger('webhook');

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST the completion/failure payload to the caller's `webhook_url` via native fetch.
 *
 * Best-effort with bounded exponential backoff: a webhook that never succeeds does NOT
 * fail the job, because `GET /jobs/:id` and `GET /jobs/:id/model` remain the pull
 * fallback. Returns whether delivery ultimately succeeded (for logging only).
 */
export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (res.ok) {
        log.info({ url, jobId: payload.job_id, status: res.status }, 'webhook delivered');
        return true;
      }
      log.warn(
        { url, jobId: payload.job_id, status: res.status, attempt },
        'webhook non-2xx response',
      );
    } catch (err) {
      log.warn({ err, url, jobId: payload.job_id, attempt }, 'webhook delivery error');
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_ATTEMPTS) {
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  log.error({ url, jobId: payload.job_id }, 'webhook delivery failed after retries');
  return false;
}
