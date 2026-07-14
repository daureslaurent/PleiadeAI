import { settingsService } from '../../domain/settings/settings.service';

/**
 * Shared plumbing for the Google-API-backed tools (`web_search` google provider, `youtube`,
 * `google_maps`). All three ride the single operator-managed API key from Settings → Connections →
 * Google APIs — tools read it fresh per call so a key rotation never needs a redeploy.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** The friendly error every Google tool returns when the shared key isn't configured. */
export const NO_KEY_ERROR =
  'Google API key not configured — the operator must set it in Settings → Connections → Google APIs';

/** The shared Google API key ('' when unconfigured) and the Custom Search engine id. */
export async function googleCredentials(): Promise<{ apiKey: string; cseId: string }> {
  const s = await settingsService.get();
  return { apiKey: s.google_api_key, cseId: s.google_cse_id };
}

/**
 * GET a Google API endpoint with a hard timeout and normalized error reporting. Google's JSON
 * errors come in two dialects — `{ error: { message } }` (googleapis.com) and
 * `{ status, error_message }` (maps.googleapis.com) — both are surfaced as a thrown Error so the
 * model sees *why* a call failed (quota, API not enabled, bad key) instead of an opaque status.
 */
export async function googleGet(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    const apiError = (body.error as { message?: string } | undefined)?.message;
    const mapsStatus = typeof body.status === 'string' ? body.status : undefined;
    const mapsError = typeof body.error_message === 'string' ? body.error_message : undefined;

    if (!res.ok) throw new Error(apiError ?? mapsError ?? `Google API returned ${res.status}`);
    // Maps web services report failures with HTTP 200 + a non-OK `status` field.
    if (mapsStatus && mapsStatus !== 'OK' && mapsStatus !== 'ZERO_RESULTS') {
      throw new Error(mapsError ? `${mapsStatus}: ${mapsError}` : mapsStatus);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}
