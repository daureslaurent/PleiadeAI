import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { mailAccountRepository } from '../../../domain/mail/mail-account.repository';
import {
  buildAuthUrl,
  exchangeCode,
  oauthClient,
  verifyState,
  MailOAuthError,
} from '../../../domain/mail/google-oauth';
import { fetchProfileEmail } from '../../../domain/mail/gmail.service';
import { encryptSecret } from '../../../isolation/ssh.service';

const log = createLogger('mail-routes');

/**
 * Linked Gmail mailboxes (Settings → Connections; `GMAIL_TOOL_PLAN.md`).
 *
 * Two routers because the OAuth callback is a *browser redirect from Google* and cannot carry a
 * JWT: `mailOauthCallbackRouter` is mounted without `requireAuth` and is instead guarded by the
 * signed single-purpose `state` token minted in `POST /oauth/start` (which *is* authenticated).
 */
export const mailRouter = Router();

/** Linked accounts. Refresh tokens are `select: false` and never appear in these responses. */
mailRouter.get('/accounts', async (_req, res) => {
  res.json(await mailAccountRepository.list());
});

mailRouter.delete('/accounts/:id', async (req, res) => {
  const account = await mailAccountRepository.delete(req.params.id);
  if (!account) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

/** Start a link flow: hand the browser Google's consent URL (state-JWT inside). */
mailRouter.post('/oauth/start', async (_req, res) => {
  try {
    res.json({ url: await buildAuthUrl() });
  } catch (err) {
    if (err instanceof MailOAuthError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export const mailOauthCallbackRouter = Router();

/**
 * Google redirects here after consent. Exchange the code, ask Gmail which address consented, store
 * the refresh token encrypted, then bounce the browser back to Settings → Connections with the
 * outcome in the query string (the page itself is JWT-gated as usual — only the redirect is open).
 */
mailOauthCallbackRouter.get('/', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const settingsUrl = async () => {
    try {
      return `${(await oauthClient()).publicBaseUrl}/settings/connections`;
    } catch {
      return '/settings/connections';
    }
  };

  try {
    if (error) throw new MailOAuthError(`Google reported: ${error}`);
    if (!code || !state) throw new MailOAuthError('missing code/state');
    verifyState(state);

    const { accessToken, refreshToken, scopes } = await exchangeCode(code);
    const email = await fetchProfileEmail(accessToken);
    await mailAccountRepository.upsertLinked(email, encryptSecret(refreshToken), scopes);

    log.info({ email }, 'gmail account linked');
    res.redirect(`${await settingsUrl()}?mail=linked&email=${encodeURIComponent(email)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'gmail oauth callback failed');
    res.redirect(`${await settingsUrl()}?mail=error&reason=${encodeURIComponent(message.slice(0, 200))}`);
  }
});
