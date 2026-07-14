import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { settingsService } from '../settings/settings.service';

/**
 * Google OAuth 2.0 plumbing for linking mailboxes (see `GMAIL_TOOL_PLAN.md`). No SDK — the three
 * calls involved (consent URL, code exchange, refresh) are plain HTTPS against Google's documented
 * endpoints, which keeps the dependency surface at zero.
 *
 * The client ID/secret and the public base URL come from the settings singleton (Settings →
 * Connections); the redirect URI is always `<public_base_url>/api/mail/oauth/callback` and the UI
 * shows that exact string for the operator to register on the Google Cloud console.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Read-only mail access — deliberately the narrowest Gmail scope; nothing here can write/modify. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** How long a started link flow stays valid before the state token expires. */
const STATE_TTL = '10m';

export class MailOAuthError extends Error {}

interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  publicBaseUrl: string;
}

/** Resolve the operator's OAuth client config, or explain exactly what is missing. */
export async function oauthClient(): Promise<OAuthClient> {
  const s = await settingsService.get();
  const missing = [
    !s.public_base_url && 'public base URL',
    !s.google_client_id && 'Google client ID',
    !s.google_client_secret && 'Google client secret',
  ].filter(Boolean);
  if (missing.length) {
    throw new MailOAuthError(
      `Google OAuth is not configured — set the ${missing.join(', ')} on Settings → Connections.`,
    );
  }
  const publicBaseUrl = s.public_base_url.replace(/\/+$/, '');
  return {
    clientId: s.google_client_id,
    clientSecret: s.google_client_secret,
    redirectUri: `${publicBaseUrl}/api/mail/oauth/callback`,
    publicBaseUrl,
  };
}

/**
 * Build the consent URL that starts a link flow. `state` is a short-lived single-purpose JWT so the
 * (necessarily unauthenticated) callback can prove the flow was started by the logged-in operator.
 */
export async function buildAuthUrl(): Promise<string> {
  const client = await oauthClient();
  const state = jwt.sign({ purpose: 'mail_oauth' }, env.JWT_SECRET, { expiresIn: STATE_TTL });
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    // `offline` + forced consent guarantees Google returns a refresh token even on re-link.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

/** Verify the callback's state JWT. Throws on anything but a fresh token we signed for this flow. */
export function verifyState(state: string): void {
  const claims = jwt.verify(state, env.JWT_SECRET) as { purpose?: string };
  if (claims.purpose !== 'mail_oauth') throw new MailOAuthError('state token has the wrong purpose');
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new MailOAuthError(
      `Google token endpoint refused (${json.error ?? res.status}): ${json.error_description ?? 'no detail'}`,
    );
  }
  return json;
}

/** Exchange the callback's authorization code for tokens. */
export async function exchangeCode(
  code: string,
): Promise<{ accessToken: string; refreshToken: string; scopes: string }> {
  const client = await oauthClient();
  const json = await tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: 'authorization_code',
  });
  if (!json.access_token || !json.refresh_token) {
    throw new MailOAuthError('Google returned no refresh token — remove the app from the Google account and re-link.');
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, scopes: json.scope ?? '' };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const client = await oauthClient();
  const json = await tokenRequest({
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: 'refresh_token',
  });
  if (!json.access_token) throw new MailOAuthError('Google returned no access token on refresh');
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}
