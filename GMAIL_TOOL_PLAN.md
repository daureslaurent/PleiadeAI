# GMAIL_TOOL_PLAN.md — Read-only Gmail for agents

Decided with the operator (July 2026):

- **Gmail REST API + OAuth 2.0**, scope `gmail.readonly` only. The operator creates a Google Cloud
  OAuth client once and pastes its client ID/secret into Settings; accounts are then linked via the
  standard consent redirect. Refresh tokens are AES-256-GCM encrypted at rest (same helper as
  isolation SSH keys) and `select: false` — never returned to any client.
- **Multiple accounts, per-agent grant.** Linked mailboxes live in a new `mail_accounts` collection;
  each agent lists the account ids it may read (`agent.mail_accounts`, edited on the Agents page).
- **Read-state guarantee.** The tools only ever call `users.messages.list/get` — the Gmail API does
  not change UNREAD state on reads (only an explicit `messages.modify` would, and it is never
  called). Mail is never marked read in the origin mailbox.
- **Tool surface (opt-in via `tools_allowed`):**
  - `list_mail` — label (default `INBOX`), `limit` (≤25), `unread_only`, Gmail `query` syntax;
    returns metadata only (id/from/to/subject/date/snippet/unread/has_attachments), newest first.
  - `read_mail` — message id → headers + plain-text body (HTML converted/stripped, truncated
    ~20k chars with a marker) + attachment metadata (name/type/size — no download in v1).
- **Settings UI:** a new **Connections** category (`/settings/connections`) holding the Google
  OAuth client config (client ID, client secret, public base URL → shows the exact redirect URI to
  register) and the linked-accounts manager (connect / status / unlink).

## Backend

| Piece | File |
|---|---|
| Account model (`refresh_token_enc` select:false) | `backend/src/domain/mail/mail-account.model.ts` |
| Repository | `backend/src/domain/mail/mail-account.repository.ts` |
| OAuth dance (auth URL, code/refresh exchange, signed `state` JWT) | `backend/src/domain/mail/google-oauth.ts` |
| Gmail REST client + MIME→text extraction, per-account token cache | `backend/src/domain/mail/gmail.service.ts` |
| Settings singleton: `public_base_url`, `google_client_id`, `google_client_secret` | `settings.model/service/routes` |
| Routes: `GET/DELETE /api/mail/accounts`, `POST /api/mail/oauth/start`, unauth'd `GET /api/mail/oauth/callback` (state-JWT-guarded, redirects back to `/settings/connections`) | `transport/http/routes/mail.routes.ts` + `index.ts` |
| Agent grant field | `agent.model.ts` (`mail_accounts: [String]`) |
| Tools `list_mail` / `read_mail` (grant-checked via `ctx.agentId`) | `tools/core/mail.ts` + `tools/registry.ts` |
| Migration (settings fields + agents backfill) | `backend/migrations/2026…-gmail-accounts.js` |

Security notes: `google_client_secret` / `refresh_token_enc` match the existing `redact.ts`
pattern (`secret$`, `_enc$`) so API-key callers never see them; the callback route validates a
10-minute single-purpose state JWT signed with `JWT_SECRET`; no new npm dependencies (plain
`fetch` against `accounts.google.com` / `gmail.googleapis.com`).

## Frontend

- `categories.ts` + `SettingsLayout.tsx`: new `connections` category/panel.
- `panels/ConnectionsPanel.tsx`: OAuth client section (with copyable redirect URI) + accounts manager.
- `managers/MailAccountsManager.tsx`: linked accounts list (status dot, unlink) + "Connect Google
  account" → `POST /mail/oauth/start` → browser navigates to Google; consumes
  `?mail=linked|error` on return.
- `context.tsx`: loads mail accounts alongside endpoints/servers.
- `lib/api.ts`: `mailApi`, `MailAccount`, new settings fields, `Agent.mail_accounts`.
- `AgentsView.tsx`: "Mailboxes" checkbox section (grants), saved with the agent.

Styling per `DIRECT_ART.md`: glass sections, white-alpha hairlines, emerald/red status dots,
mono for addresses/ids, no new keyframes.
