import { createLogger } from '../../config/logger';
import { decryptSecret } from '../../isolation/ssh.service';
import { mailAccountRepository } from './mail-account.repository';
import { refreshAccessToken, MailOAuthError } from './google-oauth';

const log = createLogger('gmail');

/**
 * Minimal Gmail REST client for the read-only mail tools (see `GMAIL_TOOL_PLAN.md`).
 *
 * READ-STATE GUARANTEE: this module only ever calls `users.messages.list` / `users.messages.get`
 * (+ `getProfile` at link time). The Gmail API never mutates UNREAD on reads — only an explicit
 * `messages.modify` would, and no such call exists here — so agents reading mail leave the origin
 * mailbox untouched.
 */

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {}

/** Per-account access-token cache; Google access tokens live ~1h, refreshed 60s before expiry. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessTokenFor(accountId: string): Promise<string> {
  const cached = tokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const account = await mailAccountRepository.findByIdWithToken(accountId);
  if (!account) throw new GmailError('mail account no longer exists');

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(account.refresh_token_enc);
  } catch {
    throw new GmailError('stored token cannot be decrypted (encryption secret changed?) — re-link the account');
  }

  try {
    const { accessToken, expiresIn } = await refreshAccessToken(refreshToken);
    tokenCache.set(accountId, { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 });
    return accessToken;
  } catch (err) {
    // Surface a revoked/broken link on Settings → Connections rather than failing silently forever.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MailOAuthError) void mailAccountRepository.markError(accountId, message);
    throw new GmailError(`could not authenticate with Google: ${message}`);
  }
}

async function gmailGet<T>(accountId: string, path: string, params?: Record<string, string | string[]>): Promise<T> {
  const token = await accessTokenFor(accountId);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const qs = search.toString();
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log.warn({ accountId, path, status: res.status }, 'gmail api error');
    throw new GmailError(`Gmail API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** The linked mailbox's own address — called once at link time to name the account. */
export async function fetchProfileEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${API}/profile`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GmailError(`Gmail profile lookup failed (${res.status})`);
  const json = (await res.json()) as { emailAddress?: string };
  if (!json.emailAddress) throw new GmailError('Gmail profile has no email address');
  return json.emailAddress;
}

// ---------------------------------------------------------------------------
// Message shapes (the slices of the Gmail REST payloads we actually read)

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export interface MailSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface MailAttachmentMeta {
  filename: string;
  mime_type: string;
  size: number;
}

export interface MailContent {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  unread: boolean;
  labels: string[];
  body: string;
  truncated: boolean;
  attachments: MailAttachmentMeta[];
}

const header = (headers: GmailHeader[] | undefined, name: string): string =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/**
 * List messages, newest first (Gmail's native order). `query` takes Gmail search syntax
 * (`from:`, `subject:`, `newer_than:7d`, …); `unreadOnly` folds into it as `is:unread`.
 * Metadata-only fetches — bodies stay on the server until `read_mail` asks for one.
 */
export async function listMail(
  accountId: string,
  opts: { label?: string; limit?: number; query?: string; unreadOnly?: boolean },
): Promise<MailSummary[]> {
  const q = [opts.query?.trim(), opts.unreadOnly ? 'is:unread' : '']
    .filter(Boolean)
    .join(' ');
  const listing = await gmailGet<{ messages?: { id: string }[] }>(accountId, '/messages', {
    maxResults: String(Math.min(Math.max(opts.limit ?? 10, 1), 25)),
    labelIds: (opts.label || 'INBOX').toUpperCase(),
    ...(q ? { q } : {}),
  });
  const ids = (listing.messages ?? []).map((m) => m.id);

  const messages = await Promise.all(
    ids.map((id) =>
      gmailGet<GmailMessage>(accountId, `/messages/${id}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      }),
    ),
  );

  return messages.map((m) => ({
    id: m.id,
    from: header(m.payload?.headers, 'From'),
    to: header(m.payload?.headers, 'To'),
    subject: header(m.payload?.headers, 'Subject'),
    date: header(m.payload?.headers, 'Date'),
    snippet: m.snippet ?? '',
    unread: m.labelIds?.includes('UNREAD') ?? false,
  }));
}

/** Fetch one message in full and reduce it to agent-readable plain text + attachment metadata. */
export async function readMail(accountId: string, id: string, maxChars: number): Promise<MailContent> {
  const m = await gmailGet<GmailMessage>(accountId, `/messages/${id}`, { format: 'full' });
  const headers = m.payload?.headers;
  const { text, attachments } = extractContent(m.payload);
  const truncated = text.length > maxChars;
  return {
    id: m.id,
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    cc: header(headers, 'Cc'),
    subject: header(headers, 'Subject'),
    date: header(headers, 'Date'),
    unread: m.labelIds?.includes('UNREAD') ?? false,
    labels: m.labelIds ?? [],
    body: truncated ? `${text.slice(0, maxChars)}\n\n[… truncated: full body is ${text.length} characters]` : text,
    truncated,
    attachments,
  };
}

// ---------------------------------------------------------------------------
// MIME → text

/** Walk the MIME tree: prefer text/plain, fall back to de-tagged text/html, collect attachments. */
function extractContent(payload: GmailPart | undefined): { text: string; attachments: MailAttachmentMeta[] } {
  const plains: string[] = [];
  const htmls: string[] = [];
  const attachments: MailAttachmentMeta[] = [];

  const walk = (part: GmailPart | undefined): void => {
    if (!part) return;
    if (part.filename) {
      attachments.push({
        filename: part.filename,
        mime_type: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? 0,
      });
    } else if (part.body?.data) {
      const decoded = Buffer.from(part.body.data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/plain') plains.push(decoded);
      else if (part.mimeType === 'text/html') htmls.push(decoded);
    }
    part.parts?.forEach(walk);
  };
  walk(payload);

  const text = plains.length ? plains.join('\n\n') : htmls.map(htmlToText).join('\n\n');
  return { text: text.trim(), attachments };
}

/** Good-enough HTML→text for mail bodies: drop head/script/style, keep line structure, unescape. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}
