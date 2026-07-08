/**
 * Secret scrubbing for API-key-authenticated responses.
 *
 * Several read endpoints hand the operator's own credentials back to the browser on purpose —
 * `GET /api/endpoints` returns each inference server's `api_key` in plaintext so the Settings form
 * can prefill it, and `GET /api/settings` does the same for `embedding_api_key`. That is fine for a
 * JWT session (the operator already knows those secrets) but an API key must never become a way to
 * exfiltrate them. Rather than special-casing routes, we filter the serialized body in one place.
 */

/** Property names whose values are replaced wholesale. Matched case-insensitively on the leaf key. */
const SECRET_KEY_PATTERN = /(^|_)(password|secret|token)$|api_key|key_hash|_enc$|^private_key/i;

const REDACTED = '[redacted]';

/**
 * Replace every property whose name looks secret with `[redacted]`, recursively.
 *
 * `input` must already be plain JSON — see {@link toRedactedJson}. Handlers hand `res.json` live
 * Mongoose documents, whose secrets only surface once `toJSON` has run, so walking the raw value
 * would silently miss them.
 */
function walk(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(walk);
  if (input === null || typeof input !== 'object') return input;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : walk(child);
  }
  return out;
}

/**
 * Normalize any `res.json` argument (Mongoose doc, array of docs, POJO…) to plain JSON via the same
 * `JSON.stringify` path Express would take, then scrub it. `undefined` bodies pass through.
 */
export function toRedactedJson(body: unknown): unknown {
  if (body === undefined) return body;
  return walk(JSON.parse(JSON.stringify(body)));
}
