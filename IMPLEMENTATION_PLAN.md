# PleiadesAI — Implementation Plan & Build Handle

> Durable implementation guide derived from the three architecture specs
> (`01-PLEIADES_ARCHITECTURE_AND_DATA.md`, `02-SKILLS_AND_AUTONOMY.md`,
> `03-FRONTEND_UI_AND_STREAMING.md`). This file is the canonical execution handle:
> follow the build sequence, honor the locked decisions, and check off steps as they land.

## 1. Context
PleiadesAI is a greenfield, developer-focused multi-agent AI command center. Philosophy:
**absolute runtime transparency** (IDE/debugger-style frontend) and **strict architectural
isolation**. The backend is stateless Node/TypeScript with an **in-process EventBus**; inference
runs on a remote `llama.cpp` OpenAI-compatible endpoint. State lives in MongoDB; vector memory in
Qdrant, isolated per agent.

The repo currently contains only the specs, `docker-compose.yml`, and two `Dockerfile`s — no
source yet.

## 2. Fixed Constraints (already baked into scaffolding — honor, do not change)
- **Frontend = Vite React SPA.** `frontend/Dockerfile` builds to `/app/dist` → nginx and uses
  `VITE_API_URL` / `VITE_WS_URL` build args. (Not Next.js.)
- **Backend = Node 22-alpine.** `backend/Dockerfile` compiles TS → `dist/index.js`; Python 3 +
  build toolchain pre-installed for the skill sandbox. Entry: `node dist/index.js`, port `4000`.
- **Services:** `pleiades_mongo` (27017), `pleiades_qdrant` (6333/6334), `pleiades_backend` (4000),
  `pleiades_frontend` (3000), network `pleiades_net`. `LLAMA_API_URL` points at the remote llama.cpp.
- **Reuse, do not recreate:** `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`,
  `.gitignore`.

## 3. Locked Technical Decisions
1. **Mongo data layer — Mongoose ODM.** Typed schemas/models. `agents.parameters` is
   `Map<string,string>`. migrate-mongo owns migrations + indexes.
2. **EventBus — custom generic TypedEventBus.** `class TypedEventBus extends EventEmitter` with an
   `EventMap` generic; every payload is a discriminated-union interface. Compile-time only, no deps.
3. **Skill sandbox.** TS: `esbuild.transformSync(src, { loader: 'ts' })` at invocation, run JS in a
   pooled `worker_threads` Worker (`{ eval: true }`). Python: `child_process` with JSON over
   stdin/stdout. Both under a hard **15s** timeout; stdout/stderr/exit piped to Pino.
4. **LLM client — official `openai` SDK** pointed at `LLAMA_API_URL` (streaming + tool calls). A
   `<think>` state-machine parser sets the WS `is_reasoning` flag. Multimodal via `image_url`
   Base64 blocks.

## 4. Directory Blueprint

### `/backend`
```
backend/
├── package.json · tsconfig.json · migrate-mongo-config.js
├── migrations/
└── src/
    ├── index.ts                    # composition root: HTTP + socket.io + Agenda + EventBus
    ├── config/{env.ts, logger.ts}
    ├── core/
    │   ├── event-bus/{EventBus.ts, events.types.ts}
    │   ├── session/SessionLock.ts
    │   └── circuit-breaker/CircuitBreaker.ts
    ├── domain/
    │   ├── agents/{agent.model.ts, agent.repository.ts, jit-builder.ts}
    │   ├── notifications/{notification.model.ts, repository}
    │   └── memory/qdrant.service.ts
    ├── inference/LlamaClient.ts
    ├── orchestrator/{AgentRunner.ts, HopGuard.ts, streaming/ReasoningParser.ts}
    ├── tools/
    │   ├── registry.ts
    │   ├── core/{setAgentParameter.ts, askAgent.ts}
    │   └── sandbox/{SkillRunner.ts, ts-worker.ts, py-runner/runner.py}
    ├── autonomy/agenda.setup.ts
    ├── alerts/{AlertEngine.ts, telegram.service.ts}
    ├── transport/
    │   ├── http/{middleware/auth.ts, routes/}
    │   └── ws/{socket.ts, bridge.ts}
    └── types/
```

### `/frontend` (Vite · React · TS · Tailwind · shadcn/ui)
```
frontend/
├── package.json · vite.config.ts · tailwind.config.ts · index.html
└── src/
    ├── main.tsx · App.tsx
    ├── lib/{api.ts, socket.ts, ws-events.types.ts}
    ├── store/            # Zustand: auth + live-stream state
    ├── components/{ui/, chat/, debugger/, hops/}
    └── views/{AuthGuard, AgentWorkspace, SkillAgentMatrix, MemoryVault, AutonomyInbox}.tsx
```

## 5. Data Schemas (Mongoose)
- **agents**: `name`, `system_prompt`, `tools_allowed: string[]`, `qdrant_namespace`,
  `parameters: Map<string,string>`.
- **notifications**: `agent_id`, `title`, `content`, `status: 'unread'|'read'`, `created_at`.
- **skills** (implied by dynamic skill env): `name`, `language: 'ts'|'py'`, `source`, `enabled`,
  `failure_count`, `disabled_reason`.

## 6. WebSocket Payload Contract (backend `ws/bridge.ts` ⇄ frontend `ws-events.types.ts`)
```
stream_chunk  { agent, content, is_reasoning }
agent_hop     { from, to, depth, query }
tool_start    { agent, tool }
tool_end      { agent, status, result }
system_alert  { level, message }
```

## 7. Build Sequence (generate step-by-step; confirm each layer before the next)
- [x] **Step 1 — Backend foundation:** `package.json`, `tsconfig.json`, `migrate-mongo-config.js`,
  `config/env.ts` (MONGO_URI, QDRANT_URL, LLAMA_API_URL, JWT_SECRET, TELEGRAM_*), `config/logger.ts`.
- [x] **Step 2 — Core primitives:** `event-bus/events.types.ts` + `EventBus.ts`;
  `session/SessionLock.ts` (in-process active-session registry, cron yields to user);
  `circuit-breaker/CircuitBreaker.ts` (per-skill consecutive-failure counter → trip/disable).
- [x] **Step 3 — Domain + persistence:** Mongoose models/repos for agents & notifications;
  `jit-builder.ts` (inject `parameters` markdown block atop system prompt; append tool-acquired
  Base64 images to context); `memory/qdrant.service.ts` (per-agent namespace isolation);
  `migrations/` + indexes.
- [x] **Step 4 — Inference + streaming:** `LlamaClient.ts` (openai SDK, streaming, tool-call
  assembly, multimodal); `ReasoningParser.ts` (`<think>` state machine → `is_reasoning`).
- [x] **Step 5 — Tools + sandbox:** `registry.ts`, `core/setAgentParameter.ts`, `core/askAgent.ts`;
  `sandbox/SkillRunner.ts`, `ts-worker.ts`, `py-runner/runner.py` (esbuild JIT, worker pool, 15s
  timeout, Pino piping, circuit-breaker wired).
- [x] **Step 6 — Orchestrator:** `AgentRunner.ts` (single-turn LLM ↔ tool loop, emits bus events);
  `HopGuard.ts` (`ask_agent` depth counter, hard max **3** → structural error).
- [x] **Step 7 — Autonomy + alerts:** `agenda.setup.ts` (consult SessionLock, queue/yield to active
  session); `AlertEngine.ts` + `telegram.service.ts` (dual fan-out: Mongo notification + Telegram).
- [x] **Step 8 — Transport:** `http/` (JWT Bearer middleware; routes: auth, agents, skills, memory,
  inbox); `ws/socket.ts` (socket.io + handshake JWT middleware, drop on expiry) + `ws/bridge.ts`
  (EventBus → WS payloads per §6); `index.ts` composition root.
- [x] **Step 9 — Frontend:** `lib/{api,socket,ws-events.types}.ts`; views AuthGuard,
  AgentWorkspace (chat + debugger drawer), SkillAgentMatrix (Monaco + editable KV grid),
  MemoryVault, AutonomyInbox (schedule + inbox + kill switch); `components/hops/*` nested sub-chats.

## 7b. Build status & deviations (all steps implemented)
All nine steps are generated; `backend` and `frontend` both typecheck and build clean.
Intentional deviations from the original blueprint:
- Added `backend/scripts/copy-assets.js` + a `build:assets` step so the Python `runner.py`
  survives the TS-only `tsc` build; updated `backend/Dockerfile` to `COPY scripts`.
- Added single-operator login (`AUTH_USERNAME`/`AUTH_PASSWORD` env + `POST /api/auth/login`);
  the spec described a JWT guard but no user store. Required secrets added to `docker-compose.yml`
  and `backend/.env.example`.
- Skills run in a **fresh worker/subprocess per invocation** (clean isolation) bounded by a
  `SKILL_WORKER_POOL_SIZE` semaphore, rather than a long-lived pool.
- `components/hops/` sub-chat panels are represented inline in the debugger drawer via
  `agent_hop` trace entries (depth-labelled) rather than a separate nested component.
- Added `frontend/nginx.conf` for SPA fallback; Dockerfile now serves on port 3000.

## 8. Verification
- `docker compose build` succeeds for both backend and frontend stages.
- `docker compose up` → Mongo + Qdrant + backend + frontend healthy; Pino boot logs show EventBus,
  socket.io, and Agenda initialized.
- E2E via frontend: authenticate (JWT) → Agent Workspace → send message → observe streamed tokens,
  a `<think>` block rendered as reasoning, a tool invocation (`tool_start`/`tool_end`) in the
  debugger drawer, and an `ask_agent` hop as a nested sub-chat.
- Fail a sandbox skill 3× → circuit breaker trips (`system_alert`) and marks the skill `disabled`.
- Fire an Agenda job while a user session is active on the same agent → it yields; on completion,
  confirm both a Mongo `notifications` doc and a Telegram message are produced.
- Hop guard: force `ask_agent` chains beyond depth 3 → structural error, no runaway recursion.
