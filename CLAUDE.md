# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What PleiadesAI is

A single-operator, multi-agent AI orchestration "command center". A stateless Node/TypeScript
backend runs agents that stream tokens from a remote `llama.cpp` server, call tools/skills in a
sandbox, delegate to each other via `ask_agent` hops, recall memories from Qdrant, and run
autonomous cron jobs. A React/Vite frontend renders the live event stream (chat + a debugger drawer
showing tool calls, reasoning `<think>` blocks, and cross-agent hops).

The `NN-*.md` files at the repo root (`01-PLEIADES_ARCHITECTURE_AND_DATA.md`, etc.) are the design
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
  guarded by `HopGuard` (`MAX_AGENT_HOPS`, default 3). **A batch of tool calls runs concurrently**
  (`TOOL_PARALLEL_PLAN.md`): the model emits independent calls together, so `planToolGroups` groups
  the consecutive ones whose tool declares `parallelSafe` (reads only — `tools/parallel-safety.ts`)
  and runs each group with a concurrency cap. Each call buffers its own messages and the buffers are
  spliced back in *emission* order, so the transcript is identical to the sequential one; the chat
  draws such a group as one card with a waterfall bar per call.
- **Subagents (`tools/core/task.ts`, spec `SUBAGENT_PLAN.md`).** `task` hands a self-contained brief
  to a **fresh-context copy of the calling agent** and returns only its report. That keeps the reading
  out of the parent's context, so a big small-window model can direct a small long-context one. The
  child runs on the agent's `subagent_endpoint_id/model`, else the fleet's `settings.subagent_*`, else
  the agent's own model. `explore` children are read-only (toolset narrowed by `mayRead`, each call
  re-checked by `isParallelSafe`) and parallel-safe. `work` children run alone. How many run at once is
  the **subagent endpoint's `parallel_slots`**: a per-run `Semaphore` held for a child's whole run,
  reserved in emission order, so 1 slot means strictly one child after another. Reports are capped by
  `reportBudget` from the parent's remaining `n_ctx`. Children never hold `task`/`ask_agent`/
  `annuaire`/`ask_parent`/`ask_user`/`todowrite`/`loop_done`, and they assemble their prompt in module
  scope `subagent`: each module has an "In subagent runs" switch (`modules_disabled_subagent`,
  default from `subagentDefault`). Because several runs stream at once, **live events are routed by
  `ctx.runId`, never by a frame stack**, in both `TurnRecorder` and the chat store. A task bubble nests
  inside its tool block (`tool.subagent`).
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
  (never baked into image layers) and encrypted at rest. The profile's `network` mode also decides
  *where* execution lands: `vpn` routes the container's netns through a per-profile gluetun, and
  **`ssh`** (`isolation/remote-ssh.ts`, spec `SSH_ISOLATION_PLAN.md`) turns the container into a jump
  box — `bash`, the file tools and skills all run on a remote host over SSH, invisibly to the agent,
  since they all funnel through the single `AgentExecutor`.
- **Media generation (`media/`, `domain/media-workflows/`, spec `COMFYUI_MEDIA_PLAN.md`).** The four
  media tools (`generate_image`, `generate_video`, `generate_sound`, `edit_image`) run **workflow
  graphs** on a remote **ComfyUI** server (Settings → Connections). A workflow is imported once — the
  API-format graph is *snapshotted* into `media_workflows`, since ComfyUI keeps its run history in RAM
  and its editor saves a different, subgraph-bearing format — and an auto-binder maps logical
  parameters (prompt, seed, size, length…) onto concrete node inputs. Which workflow each tool runs is
  a per-tool select on the Tools page, whose options are resolved server-side at request time via
  `ToolConfigField.optionsSource` (`tools/config-options.ts`) rather than frozen into the tool module.
  `ComfyProgressSocket` connects *before* submitting so a fast job can't finish unobserved, and polls
  `/history` in parallel so a dropped socket never loses a result.
- **Flows (`flows/`, `domain/flows/`, spec `FLOWS_PLAN.md`).** Operator-authored node graphs run by
  the backend in a *fixed* order — the deterministic counterpart to an agent deciding its own tool
  order. Nodes wrap the same primitives the agent layer uses (`agentRunner.run`, `generateMedia`, any
  registered tool/skill) plus control flow (condition, agent router, human approval, for_each). The
  node registry (`flows/nodes/index.ts`) is the single source of truth: `GET /api/flows/node-types`
  serves it, so the canvas palette and inspector form render themselves from the handlers' declared
  ports and `ToolConfigField[]`. **A run's `sessionId` is its run id** — that one choice makes every
  produced artifact an ordinary session resource (handle + preview route) and makes the page's
  existing `session:subscribe` deliver agent/tool/media events with no new plumbing. Fired manually,
  by cron (`flow:scheduled_run`), or by an agent via the `run_flow` tool.
- **Configured APIs (`domain/apis/`, spec `API_TOOL_PLAN.md`).** Two tools over one collection:
  `api_man` is the catalogue (which HTTP APIs this instance has been given, and the named operations
  each offers), `api` is the caller (one operation id + its parameters → parsed JSON). An `api_sources`
  document is a base URL, an auth method and a list of **operations**, each with declared parameters
  whose `description` is the actual prompt surface — the agent picks `weather.forecast`, never a URL,
  so the reachable surface is exactly what the operator configured on Settings → APIs. The credential
  is AES-encrypted, `select: false`, and never leaves the backend; `methods_allowed` defaults to
  `GET`/`HEAD` so writes are opt-in per API; a path parameter is percent-encoded and the resolved
  origin re-checked, so no argument can walk a call onto another host. `api-caller.service.ts` is the
  single request builder, shared by the tool and the settings page's Test button so they cannot drift.
  Twenty-six presets ship in `builtin-catalogue.ts` (Wikipedia, GitHub, Hacker News, 4chan, OSV,
  Open-Meteo…), installed at boot into ordinary editable documents; the settings singleton remembers
  what has been *offered* rather than what is present, so a deleted preset stays deleted while a new
  release's presets still arrive. `oauth2` (client-credentials, token cached and renewed in the
  backend) is what makes Reddit reachable at all, and `auth_optional` is for APIs that answer
  anonymously but answer better with a key.

- **Modules (`modules/`, spec `MODULES_PLAN.md`).** The prompt is assembled from a **register** of
  modules rather than a hard-coded list of renderers. A module owns three things at once: the prompt
  blocks it contributes, the core tools those blocks talk about, and the settings that tune it — so
  one switch on Settings → Modules removes all three. Blocks declare a `placement`
  (`system_head` before the operator's authored `system_prompt`, `system_tail` after it,
  `system_suffix` last, `user_suffix` on the user turn) and an `order`; that ordering *is* the
  authority contract — operator-owned text before the authored prompt, the agent-writable notebook
  after it, the conversation's modes last. **Modules render, they never fetch**: `AgentRunner`
  prepares one `PromptContext` per turn and skips the query behind a disabled module, so Visuals off
  costs no image note *and* Memory off costs no embedding. Enablement is a list of *disabled* ids on
  the settings singleton (like `global_modes_disabled`), so a release that adds a module has it on by
  default; `mandatory` ones (Environment, Tool use, Session) refuse to be switched off, and only the
  board ships off — its switch writes `forum_board_enabled`, which the scheduler still reads.
  `resolveTools()` gates a core tool on `moduleEnabled(owner) && toolConfig.enabled`, and
  `prompt-usage.ts` derives its block titles from the registry, so the debugger's context breakdown
  can't drift from what was actually sent.

- **Memory (`domain/memory/`).** Each agent has a strictly siloed `qdrant_namespace`. `AgentRunner`
  auto-recalls relevant memories before a turn and fire-and-forget-persists the exchange after.
  Embeddings failures degrade gracefully (memory just skipped).
- **Autonomy (`autonomy/`, `alerts/`).** Agenda-backed cron jobs. `SessionLock` gives a live user
  chat priority over a cron job hitting the same agent. Completed headless tasks fan out to both a
  Mongo `notifications` doc (UI inbox) and, optionally, a Telegram webhook.

- **The forum and the work board (`domain/forum/`, specs `FORUM_PLAN.md` §1–11 and
  `FORUM_WORKBOARD_PLAN.md`).** Two layers with one rule between them: **the forum is where the
  fleet talks, the board is where its work lives.** The forum is categories/threads/posts plus a
  `forum_files` registry, hybrid search (Mongo `$text` + the one shared Qdrant collection
  `forum_index`), `@mentions` as rows, and the built-in `forum_keeper` moderator. Every agent post
  declares a `kind` (`finding`, `question`, `handoff`, `decision`, `status`, `review`, `note`) and
  each kind has one required field and a character ceiling, refused at write time in
  `post-contract.ts` — *before* the next turn is paid for, unlike `assertNotARepeat`, which catches
  a restatement after. The board is `forum_tasks` (goal, acceptance criteria, owner, reviewer,
  `depends_on`, deliverable) and `forum_plans` (a project's graph, manager and turn allowance).
  `forum-scheduler.ts` is an Agenda tick that reaps, computes the ready set and dispatches through
  `forum-task-runner.ts` — **it never runs inference and never writes prose**, so a five-task project
  costs work turns plus reviews and *zero* coordination turns. `submit` refuses a `done` with no
  deliverable and moves the task to `review`, which a *different* agent signs off.
  **Mentioning and waking are separate, and the author has to say which they meant**
  (`FORUM_MENTION_LOOP_PLAN.md` §5): `@name` in a post notifies and dispatches nothing, while the
  `wake` argument on the same `post_thread`/`reply` call starts one full turn per name, right away,
  through `forum-wake-queue.ts`. A post whose body names an agent is **refused** until it passes
  `wake` — the names that must act, or `[]` — so the choice is made once, explicitly, before a turn
  is paid for, instead of being guessed from prose by a pair cap and a chain ceiling. The per-thread
  (or per-project) auto-run budget is the only brake left behind it. Both master switches
  (`forum_board_enabled`, `forum_auto_reply`) ship off.

- **Auth (`transport/http/middleware/auth.ts`).** `requireAuth` accepts either the operator's session
  JWT or an **API key** (`X-API-Key`, or `Authorization: Bearer plk_…`; `domain/api-keys/`). A key is
  **read-only by default**: non-`GET`/`HEAD` methods are refused unless the key carries a matching
  write **scope** (`API_KEY_SCOPES` in `api-key.model.ts`; `WRITE_SCOPES` maps each scope to the route
  family it unlocks — currently `agents:write` → `/api/agents`). Keys are always blocked from
  `/api/api-keys` by `requireOperator`, and have their response bodies scrubbed by `redact.ts` —
  `GET /api/endpoints` and `GET /api/settings` otherwise return inference credentials in plaintext.
  Keys can't open a websocket: the WS handshake calls `verifyToken` directly. `tools/pleiades-mcp/`
  consumes this surface (MCP server + `scripts/prod.mjs` CLI).

- **Theming (`frontend/src/theme/`, spec `THEME_SYSTEM_PLAN.md`, art direction `DIRECT_ART.md`).** The
  operator picks a **theme** (whole-app palette/surfaces/type) and a **chat layout** (how a turn is
  structured) independently, at `/settings/interface`; both persist on the settings singleton
  (`ui_theme`, `ui_chat_layout`) with a localStorage cache so `index.html` paints the right theme
  before the bundle loads. Every colour, radius and font in `tailwind.config.ts` resolves to a CSS
  variable, so components name ordinary Tailwind classes and `theme/themes/<id>.css` answers — never
  hard-code a hex, an `rgba()`, or a `white`/`black` alpha (use `.hairline`, `.raise-*`, `.well*`).
  The neutral `slate-*` ramp is a **foreground** ramp (100 strongest → 600 faintest), so light
  themes invert its ends. A chat layout is a descriptor plus one `ConversationView`
  (`components/workspace/conversation/`); the shared `Blocks`/`ToolCall` renderers read the
  descriptor from `ChatLayoutContext`, which is why five layouts need no forks of the chat page.

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
