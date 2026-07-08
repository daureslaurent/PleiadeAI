import crypto from 'node:crypto';
import { createLogger } from '../../config/logger';
import { apiKeyRepository } from './api-key.repository';
import type { ApiKeyDoc } from './api-key.model';

const log = createLogger('api-keys');

/** Wire format: `plk_<prefix>_<secret>`. Only `prefix` is stored alongside sha256(whole key). */
const SCHEME = 'plk';
const PREFIX_BYTES = 4; // → 8 hex chars
const SECRET_BYTES = 32; // → 43 base64url chars

/** Don't write `last_used_at` more than once a minute per key; a polling client would hammer it. */
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

function hash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Parse `plk_<prefix>_<secret>` without throwing on garbage. Returns null for anything that isn't
 * shaped like one of our keys, so callers can 401 without distinguishing "malformed" from "unknown".
 *
 * Split on the *first two* separators only: the secret is base64url, whose alphabet includes `_`,
 * so a naive `split('_')` rejects most legitimate keys.
 */
function parse(raw: string): { prefix: string } | null {
  const firstSep = raw.indexOf('_');
  const secondSep = raw.indexOf('_', firstSep + 1);
  if (firstSep === -1 || secondSep === -1) return null;

  const scheme = raw.slice(0, firstSep);
  const prefix = raw.slice(firstSep + 1, secondSep);
  const secret = raw.slice(secondSep + 1);
  if (scheme !== SCHEME || !secret) return null;
  if (prefix.length !== PREFIX_BYTES * 2 || !/^[0-9a-f]+$/.test(prefix)) return null;
  return { prefix };
}

export interface IssuedApiKey {
  doc: ApiKeyDoc;
  /** The plaintext key. Returned exactly once, at creation — it is not recoverable afterwards. */
  plaintext: string;
}

export const apiKeyService = {
  /** Mint a new read-only key. The caller must surface `plaintext` to the operator immediately. */
  async issue(name: string): Promise<IssuedApiKey> {
    const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
    const plaintext = `${SCHEME}_${prefix}_${secret}`;
    const doc = await apiKeyRepository.create({ name, prefix, key_hash: hash(plaintext) });
    log.info({ id: String(doc._id), name, prefix }, 'api key issued');
    return { doc, plaintext };
  },

  /**
   * Resolve a presented key to its document, or null if unknown, malformed or revoked.
   *
   * The prefix narrows to a single row; the secret is then checked with a constant-time compare of
   * the two sha256 digests (equal length, so `timingSafeEqual` can't throw).
   */
  async verify(raw: string): Promise<ApiKeyDoc | null> {
    const parsed = parse(raw);
    if (!parsed) return null;

    const doc = await apiKeyRepository.findByPrefixWithHash(parsed.prefix);
    if (!doc || doc.revoked_at) return null;

    const presented = Buffer.from(hash(raw), 'hex');
    const stored = Buffer.from(doc.key_hash, 'hex');
    if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) return null;

    return doc;
  },

  /** Stamp `last_used_at`, at most once per {@link TOUCH_INTERVAL_MS}. Never awaited by a request. */
  touch(doc: ApiKeyDoc): void {
    const id = String(doc._id);
    const now = Date.now();
    if (now - (lastTouched.get(id) ?? 0) < TOUCH_INTERVAL_MS) return;
    lastTouched.set(id, now);
    apiKeyRepository.touch(id).catch((err) => log.warn({ err, id }, 'failed to stamp last_used_at'));
  },

  /** Drop a revoked/deleted key's throttle entry so the map can't grow unboundedly. */
  forget(id: string): void {
    lastTouched.delete(id);
  },
};
