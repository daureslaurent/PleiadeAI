# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What PleiadeAI is

A single-operator, multi-agent AI orchestration "command center". A stateless Node/TypeScript
backend runs agents that stream tokens from a remote `llama.cpp` server, call tools/skills in a
sandbox, delegate to each other via `ask_agent` hops, recall memories from Qdrant, and run
autonomous cron jobs. A React/Vite frontend renders the live event stream (chat + a debugger drawer
showing tool calls, reasoning `<think>` blocks, and cross-agent hops).

The `NN-*.md` files at the repo root (`01-PLEIADE_ARCHITECTURE_AND_DATA.md`, etc.) are the design
spec; source comments frequently reference their sections (e.g. "spec §4").

## Commands

Backend (`backend/`, Node ≥ 22):
- `npm run dev` — tsx watch on `src/index.ts`
- `npm run build` — `tsc` + copy non-TS assets (skill harnesses) into `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm run migrate:up | migrate:down | migrate:status` — MongoDB schema migrations (migrate-mongo)
- `node scripts/seed.mjs` — seed demo agents/skill via the running API (needs backend up + login)

Frontend (`frontend/`):
- `npm run dev` — Vite dev server
- `npm run build` — `tsc -b` + `vite build`
- `npm run typecheck` — `tsc -b --noEmit`

There is no test suite and no linter configured. Verify changes with `typecheck` and by running the
stack. The whole system boots with `docker compose up --build` from the repo root.

## Runtime dependencies

The backend requires, and compose provides: **MongoDB** (state/config), **Qdrant** (vector memory),
a CPU `llama.cpp` **embeddings** server, and **SearXNG** (web_search provider). Inference itself
runs on a *remote* `llama.cpp` server you point `LLAMA_API_URL` at (default in compose is a LAN IP —
update it). Config is validated at boot by `src/config/env.ts` (Zod) and the process exits on any
missing/invalid var. `.env.example` documents every variable.

## Architecture

Request flow for a chat turn:
`frontend socket.io` → `transport/ws/socket.ts` (JWT handshake, session lock) →
`orchestrator/AgentRunner.ts` → emits on the in-process **EventBus** → `transport/ws/bridge.ts`
translates internal events to the narrow WS wire schema → frontend `store/stream.ts` reduces them
into a `Block[]` tree.

Key seams:
- **EventBus (`core/event-bus/`)** is the backbone. `AgentRunner` never talks to the socket
  directly — it emits typed events (`agent:stream_chunk`, `agent:tool_invoke`,
  `tool:execution_complete`, `agent:ask_agent`, `agent:context_usage`, …). `bridge.ts` is the *only*
  place mapping those to the client, and it deliberately drops rich internal fields. Pino logs and
  the UI thus see the same trace. Add a new event to `events.types.ts` and wire it in `bridge.ts`.
- **AgentRunner** runs one agent turn: it JIT-assembles the prompt (`domain/agents/jit-builder.ts`
  injects the agent's `parameters` KV map + auto-recalled memories into a *single* leading system
  message — a second `system` turn breaks the GGUF chat templates), streams inference, and loops
  tool calls up to `MAX_TOOL_ITERATIONS` (8). Cross-agent delegation recurses via `makeInvoker`
  guarded by `HopGuard` (`MAX_AGENT_HOPS`, default 3).
- **Tools vs Skills.** Core tools live in `tools/core/` and are registered statically in
  `tools/registry.ts`. Skills are user-authored TS/Python stored in MongoDB and wrapped as tools at
  resolve time. `resolveTools()` binds core names directly and looks the rest up as skills; disabled
  skills / globally killed tools silently drop out of the agent's toolset. Non-subagent (top-level)
  agents always get `annuaire` + `ask_agent` even if not in `tools_allowed`.
- **Skill sandbox (`tools/sandbox/`).** TS runs in a worker thread, Python in a spawned subprocess,
  both over a JSON stdio protocol with a hard timeout and a **circuit breaker** (N consecutive
  failures → skill marked disabled in Mongo).
- **Per-agent Docker isolation (`isolation/`).** An agent can be assigned an isolation profile; on
  first tool use `AgentContainerManager.ensureReady` lazily builds/starts a dedicated container
  (Docker-out-of-Docker via the mounted host `/var/run/docker.sock`) and hands tools an
  `AgentExecutor` so `bash`/skills run *inside* the container instead of the backend. If the profile
  image isn't built it throws `IsolationNotReadyError` — isolated tools must surface the error, never
  fall back to the backend. Containers idle-stop on a timer; SSH keys are injected at runtime
  (never baked into image layers) and encrypted at rest.
- **Memory (`domain/memory/`).** Each agent has a strictly siloed `qdrant_namespace`. `AgentRunner`
  auto-recalls relevant memories before a turn and fire-and-forget-persists the exchange after.
  Embeddings failures degrade gracefully (memory just skipped).
- **Autonomy (`autonomy/`, `alerts/`).** Agenda-backed cron jobs. `SessionLock` gives a live user
  chat priority over a cron job hitting the same agent. Completed headless tasks fan out to both a
  Mongo `notifications` doc (UI inbox) and, optionally, a Telegram webhook.

- **Auth (`transport/http/middleware/auth.ts`).** `requireAuth` accepts either the operator's session
  JWT or an **API key** (`X-API-Key`, or `Authorization: Bearer plk_…`; `domain/api-keys/`). A key is
  **read-only by default**: non-`GET`/`HEAD` methods are refused unless the key carries a matching
  write **scope** (`API_KEY_SCOPES` in `api-key.model.ts`; `WRITE_SCOPES` maps each scope to the route
  family it unlocks — currently `agents:write` → `/api/agents`). Keys are always blocked from
  `/api/api-keys` by `requireOperator`, and have their response bodies scrubbed by `redact.ts` —
  `GET /api/endpoints` and `GET /api/settings` otherwise return inference credentials in plaintext.
  Keys can't open a websocket: the WS handshake calls `verifyToken` directly. `tools/pleiade-mcp/`
  consumes this surface (MCP server + `scripts/prod.mjs` CLI).

Layout: `domain/<entity>/` holds each entity's Mongoose model + repository/service; HTTP routes are
in `transport/http/routes/` (all behind `requireAuth` except `/api/auth`); the socket layer is in
`transport/ws/`. Frontend: `views/` are top-level routed pages (one per Sidebar nav item),
`components/workspace/` is the chat + debugger UI, `store/` holds Zustand stores (`auth`, `stream`),
`lib/` holds the API/socket clients and the shared WS event types.

## Conventions

- Backend is CommonJS TS compiled to `dist/`; the `build:assets` step copies skill harness files
  (`isolation/harness/*`, `tools/sandbox/py-runner/*`) that `tsc` won't. If you add a runtime non-TS
  asset, update `scripts/copy-assets.js`.
- All config access goes through the validated `env` object — don't read `process.env` directly.
- Schema changes require a new file in `backend/migrations/` (timestamped, migrate-mongo format);
  don't mutate existing migrations.
- Logging is structured Pino via `createLogger('scope')` — no `console.log` in backend runtime code
  (the env loader is the one exception, since Pino depends on it).
