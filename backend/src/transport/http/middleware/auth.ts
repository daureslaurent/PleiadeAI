import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../../../config/logger';
import { apiKeyService } from '../../../domain/api-keys/api-key.service';
import type { ApiKeyDoc } from '../../../domain/api-keys/api-key.model';
import { verifyToken, type TokenClaims } from '../jwt';
import { toRedactedJson } from './redact';

const log = createLogger('auth');

/** Express request augmented with the verified caller identity — exactly one of these is set. */
export interface AuthedRequest extends Request {
  /** Present when the caller is the operator holding a session JWT. */
  user?: TokenClaims;
  /** Present when the caller authenticated with an API key. Implies a read-only request. */
  apiKey?: ApiKeyDoc;
}

/** API keys may only read. Anything that could mutate state is refused before the handler runs. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

/**
 * Extract a presented API key. Accepts the canonical `X-API-Key` header, and also
 * `Authorization: Bearer plk_…` — most HTTP clients (and the MCP server) reach for `Authorization`
 * first, and our keys are self-identifying, so there's no ambiguity with a JWT.
 */
function extractApiKey(req: Request): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header) return header;

  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Bearer' && token?.startsWith('plk_')) return token;
  return null;
}

/**
 * Guard for every REST endpoint (spec §2). Accepts **either**:
 *
 * - a session JWT (`Authorization: Bearer <jwt>`) — full operator privileges; or
 * - an API key (`X-API-Key`) — read-only, and secrets are stripped from the response body.
 *
 * Rejects missing/invalid/expired/revoked credentials with 401 before any handler runs. API keys
 * cannot open a websocket: the WS handshake calls `verifyToken` directly.
 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const presentedKey = extractApiKey(req);

  if (presentedKey) {
    const doc = await apiKeyService.verify(presentedKey).catch((err) => {
      log.error({ err }, 'api key verification failed');
      return null;
    });
    if (!doc) {
      res.status(401).json({ error: 'invalid or revoked api key' });
      return;
    }
    if (!READ_ONLY_METHODS.has(req.method)) {
      res.status(403).json({ error: 'api keys are read-only', method: req.method });
      return;
    }

    req.apiKey = doc;
    apiKeyService.touch(doc);

    // Scrub credentials the operator's own UI is allowed to see but a key holder is not.
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => json(toRedactedJson(body))) as Response['json'];

    next();
    return;
  }

  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'missing bearer token' });
    return;
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

/**
 * Narrows an already-authenticated request to the JWT operator. Mount after {@link requireAuth} on
 * routes an API key must never reach — notably API key management itself, so a leaked key can't
 * enumerate, mint, or revoke keys (including its own).
 */
export function requireOperator(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(403).json({ error: 'this endpoint requires an operator session, not an api key' });
    return;
  }
  next();
}
