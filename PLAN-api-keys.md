# API Key System + Prod Data Retrieval Tooling

Goal: let an external agent (Claude Code) pull read-only data out of a deployed PleiadesAI
instance without handing it the operator's password or a full-privilege JWT.

## Decisions

| Question | Decision |
| --- | --- |
| Tool form | MCP server (`tools/pleiades-mcp/`) **and** a CLI (`scripts/prod.mjs`) |
| Key scope | Read-only: the key authenticates, but non-`GET`/`HEAD` methods are rejected `403` |
| Management | Full UI — a new **API Keys** section in Settings; plaintext shown once |
| Credentials | Real prod URL + key live in a gitignored `.env.prod` |

## Key format & storage

```
plk_<8 hex prefix>_<43 char base64url secret>
      ^ lookup handle       ^ never stored
```

* Mongo `api_keys` stores `prefix` (unique index) and `key_hash` = `sha256(full key)`, `select:false`.
* Verification: split on `_`, look up by `prefix`, `timingSafeEqual` the hash. No plaintext at rest.
* `last_used_at` is touched fire-and-forget (throttled to ≥60s) so the UI can show liveness.
* Revocation sets `revoked_at`; a revoked key fails verification but keeps its audit row.

## Backend changes

1. `domain/api-keys/api-key.model.ts` — schema, `timestamps: created_at/updated_at`.
2. `domain/api-keys/api-key.repository.ts` — thin data access.
3. `domain/api-keys/api-key.service.ts` — `issue()`, `verify()`, `touch()`; owns the crypto.
4. `transport/http/middleware/auth.ts` — `requireAuth` accepts **either** a JWT Bearer *or* an
   `X-API-Key` header. API-key requests are:
   * rejected `403` unless `GET`/`HEAD`;
   * passed through `redactSecrets`, which strips `api_key`, `*_api_key`, `*_password`, `*_enc`,
     `key_hash` from the JSON body. This matters: `GET /api/endpoints` and `GET /api/settings`
     return inference-server credentials in plaintext today.
5. `requireOperator` — extra guard so an API key can't read, mint, or revoke API keys.
6. `transport/http/routes/api-keys.routes.ts` — list / create / revoke / delete, JWT-only.
7. `migrations/20260708160000-api-keys.js` — collection + unique `prefix` index.

The WS handshake (`transport/ws/socket.ts`) still calls `verifyToken` directly and is untouched:
API keys cannot open a socket or drive an agent.

## Frontend

`SettingsView.tsx` gains an `ApiKeysManager` section (mirrors `FinetuneServersManager`):
list with name / prefix / last-used / created, a create form, and revoke+delete. The plaintext key
is rendered exactly once, in a copy-to-clipboard callout, and is unrecoverable afterwards.

## Tooling

* `tools/pleiades-mcp/index.mjs` — dependency-free stdio MCP server (hand-rolled JSON-RPC:
  `initialize`, `tools/list`, `tools/call`). Tools: `pleiades_get`, `pleiades_agents`,
  `pleiades_sessions`, `pleiades_session_messages`, `pleiades_llama_logs`, `pleiades_scoring_summary`,
  `pleiades_scores`, `pleiades_inbox`, `pleiades_memory`.
* `scripts/prod.mjs` — same surface as a CLI: `node scripts/prod.mjs agents`, `… get /api/skills`.
* `.mcp.json` at the repo root wires the MCP server into Claude Code.
* Both read `PLEIADES_API_URL` + `PLEIADES_API_KEY` from the environment or `.env.prod`.

## Follow-up: cloning prod → local

`scripts/clone-prod.mjs` + `domain/transfer/clone.service.ts`.

The read-only key can't reach `POST /api/transfer/export/*`, so `transfer.routes.ts` grew **GET
twins** (`/export/config`, `/export/memory`) plus a new `/export/clone` — a full-fidelity mirror
(agents, isolations, sessions, messages, scores, llama-logs) that preserves `_id`s. Preservation is
load-bearing: sessions reference `agent_id`, messages `session_id`, and scores/llama-logs carry both
as strings, so a renumbering export would arrive with every cross-reference dangling. Preserving ids
implies **replace, not merge**, hence `POST /import/clone` wipes first and demands
`{confirm:'REPLACE'}`. API keys can't reach it (GET-only).

Script guards: dry-run default, abort when source URL == target URL, abort on a non-loopback target
without `--force`, target vetted *before* credentials are sent to it.

Not cloned: endpoints (inference credentials), images, skills, settings, api_keys, Qdrant vectors.

The clone posts the whole instance in one body, so `express.json` was raised 25mb → 128mb
(`index.ts`); a real instance's messages (base64 images) + inference logs exceed 25mb. `insert()`
warns on any row shortfall — `insertMany` silently drops docs failing schema validation without
throwing, so a count check is the only reliable way to surface source data-quality loss.

## Verification

`npm run typecheck` in `backend/` and `frontend/`, then against a running stack: mint a key in the
UI, confirm `GET /api/agents` succeeds with `X-API-Key`, `POST /api/agents` returns 403,
`GET /api/api-keys` returns 403, and `GET /api/endpoints` comes back with `api_key` redacted.
