import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Playback tokens for the flux endpoint.
 *
 * A `<video src>` cannot carry an `Authorization` header, so the one route the media element hits is
 * authenticated by a signed query parameter instead: the page asks the authed API for a token and
 * appends it. The token is an HMAC over the flow id and an expiry — no database, nothing to revoke,
 * and short-lived enough that a leaked URL stops working on its own.
 */

/** Long enough to survive a paused tab and a reconnect, short enough that a copied URL goes stale. */
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function sign(payload: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');
}

export function mintStreamToken(flowId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${flowId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** True when `token` is a live signature over exactly this flow id. */
export function verifyStreamToken(token: string | undefined, flowId: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tokenFlowId, expRaw, signature] = parts as [string, string, string];
  if (tokenFlowId !== flowId) return false;

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;

  const expected = Buffer.from(sign(`${tokenFlowId}.${expRaw}`));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const STREAM_TOKEN_TTL_SECONDS = DEFAULT_TTL_SECONDS;
