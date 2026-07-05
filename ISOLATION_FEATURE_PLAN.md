# Feature: Per-Agent Docker Isolation

Run each agent's Linux-based execution (the `bash` tool + Python/TS skills) inside its **own
Docker container**, built from a **per-agent Dockerfile** editable in the Agents page. When
isolation is **off**, execution stays in `pleiade_backend` exactly as today.

## Refactor v2 — shared Isolation profiles ✅
Isolation is now a **first-class shared entity** with its own page, not embedded per-agent.
- **`isolations` collection** (`domain/isolations/*`): name, description, Dockerfile, image build
  state, `cpus/memory/network/idle`. `network` ∈ `host|bridge|none`, **default `host`** so agent
  containers share the host net stack → **LAN + host services reachable** (fixes the LAN issue).
- **Agents reference a profile**: `agent.isolation_id` (null ⇒ backend) + `isolation_volume_mode`
  (`individual` ⇒ own `/workspace` volume, `shared` ⇒ the profile's shared volume). Chosen per
  agent on the Agents page.
- **One image per profile** (`pleiade_iso_<isoId>`), built once on the Isolation page; **each agent
  still gets its own container** (`pleiade_agent_<agentId>`) → agents stay isolated from each other.
- **Routes**: `/api/isolations` CRUD + `/:id/build` (SSE) + `/:id/status`; per-agent container ops
  moved to `/api/agents/:id/container` (status/stop/delete-volume). Profile delete tears down all
  assigned containers + shared image + shared volume and unassigns agents. Agent delete removes its
  container + individual volume. Config/image changes drop stale containers so they recreate.
- **Frontend**: new **Isolation** nav page (`IsolationsView`, Monaco + Build + status + assigned
  count); Agents page shows an `AgentIsolationSelect` (profile dropdown + volume-mode + container
  controls). Greenfield migration `20260704130000` creates the collection and resets agents.

## Add-on — outbound SSH key per profile ✅
Each isolation profile can carry an **outbound SSH client key** (for `git clone` / `ssh` out):
- Fields on `isolations`: `ssh_private_key_enc` (**AES-256-GCM encrypted at rest**, Mongoose
  `select: false` so it never leaves the DB layer), `ssh_public_key`, `ssh_known_hosts`.
- `isolation/ssh.service.ts` — `encryptSecret`/`decryptSecret` (key = sha256 of `ISOLATION_ENC_KEY`
  ‖ falls back to `JWT_SECRET`) + `sshMaterialForIsolation()`.
- Injected at container-create into `~/.ssh/id_ed25519` (600), `id_ed25519.pub`, `known_hosts` via
  `docker exec` (never baked into the image). Best-effort; a bad/undecryptable key is skipped.
- API: private key is **write-only** — `PATCH` accepts plaintext `ssh_private_key` (encrypted on
  store; `''` clears; absent keeps), never returned; `GET /:id/status` exposes `ssh_key_set` only.
  Changing SSH material recreates assigned containers so the new key lands on next start.
- UI: "Outbound SSH key" panel on the Isolation page (write-only key textarea + optional public
  key / known_hosts + key-set badge + Remove). Secret `ISOLATION_ENC_KEY` documented in `.env.example`.

## Status: IMPLEMENTED ✅
Backend + frontend typecheck and build clean. Implementation notes / deviations:
- Image build uses `docker build -` (Dockerfile from stdin, **no** build context) — the default
  template needs no `COPY`/`ADD`. Add-context builds are out of scope.
- `network: 'internal'` is best-effort (`--network internal`); the two supported paths are
  `bridge` (default, internet) and `none` (offline). `bridge` is omitted from `docker create`.
- Isolation resolves **lazily on first tool call** in `AgentRunner` (memoised for the turn), so a
  pure chat turn never boots the container. Any tool call for an isolated agent triggers the boot;
  only `bash`/skills hard-error when it isn't ready — net tools ignore `ctx.exec`.
- Skill harnesses (`py_runner.py`, `node_runner.cjs`) are shipped to `dist/` by `build:assets`
  (`.cjs` added to the asset copier) and `docker cp`'d into `/opt/pleiade` at container create.

## Locked decisions (from operator)
| Topic | Decision |
|---|---|
| Docker access | Bind-mount host `/var/run/docker.sock` into backend (Docker-out-of-Docker) + `docker-cli`. |
| Lifecycle | **Persistent** per-agent container, reused across calls; `docker exec` per command. |
| Scope | `bash` tool **and** Python/TS skills route into the container. Core net tools (webFetch/search) stay on backend. |
| Workspace | **Persistent named volume** per agent at `/workspace`; deletable via explicit button. |
| Base image | Default Dockerfile ships `node + python3 + bash + git + build tools`; warn if a required runtime looks removed. |
| Build trigger | **Manual** "Build" button; live build-log stream; container recreated from new image on next use. |
| Sandbox policy | Default network **bridge (internet)** + CPU/mem caps (`1` CPU / `1g`), no `--privileged`. Per-agent overridable. |
| Not-ready | **Hard error** ("agent image not built") — never silently fall back to backend. |
| Idle | Auto-stop after idle timeout (default 30m); restart on demand; volume keeps files. |
| Teardown on disable | Stop + remove container + remove image; **keep** volume. |
| Teardown on agent delete | Stop + remove container + image + **volume**. |
| Volume wipe | Only on full agent delete (or explicit button) — never on mere toggle-off. |
| Editor | Monaco (`@monaco-editor/react`, already used by Skills) + Build/logs panel + container controls. |

## Naming
- Image: `pleiade_agent_<agentId>:latest`
- Container: `pleiade_agent_<agentId>`
- Volume: `pleiade_agent_ws_<agentId>`
- Harness dir in container: `/opt/pleiade/` (`py_runner.py`, `node_runner.js`, `docker cp`'d at create).

## Security note
Mounting `docker.sock` grants the backend root-equivalent control of the host Docker daemon.
Acceptable for this single-operator command center; documented in `docker-compose.yml`.

---

## Backend

### 1. Data model — `agent.model.ts`
Add an `isolation` subdocument:
```
isolation: {
  enabled: boolean            // default false
  dockerfile: string          // default = DEFAULT_DOCKERFILE
  image_status: 'none'|'building'|'built'|'error'   // default 'none'
  image_built_at: Date|null
  last_build_error: string|null
  cpus: string                // default '1'
  memory: string              // default '1g'
  network: 'bridge'|'none'|'internal'  // default 'bridge'
  idle_timeout_ms: number     // default 1800000
}
```
Migration adds the field to existing agents (backfill defaults). Repository gains
`updateIsolation`, `setImageStatus`.

### 2. New module — `backend/src/isolation/`
- `names.ts` — image/container/volume names from agentId.
- `dockerfile.template.ts` — `DEFAULT_DOCKERFILE` + `assertRuntimes()` heuristic warning.
- `docker.service.ts` — thin `docker` CLI wrapper via `child_process` (no new deps):
  `buildImage(streaming)`, `imageExists`, `removeImage`, `containerState`, `createContainer`,
  `startContainer`, `stopContainer`, `removeContainer`, `cpInto`, `exec(streaming)`,
  `volumeExists`, `removeVolume`.
- `AgentContainerManager.ts` — high-level lifecycle:
  - `ensureReady(agent)` → image built? else throw `IsolationNotReadyError`; ensure container
    exists (create + `docker cp` harnesses + volume mount + limits) and running (start if stopped);
    reset idle timer. Returns an `AgentExecutor`.
  - `AgentExecutor.run(command, {timeoutMs,onOutput})` → `docker exec -w /workspace`.
  - `AgentExecutor.runScript(interpreter, source, stdinJson, {timeoutMs})` → exec
    `python3 /opt/pleiade/py_runner.py` or `node /opt/pleiade/node_runner.js`, feeding
    `{source|code, args}` on stdin (mirrors current runner.py / ts-worker contract).
  - Idle map + timers; `teardown(agentId, {removeImage,removeVolume})`.
- `harness/py_runner.py` — reuse existing `runner.py` (reads `{source,args}` stdin → JSON stdout).
- `harness/node_runner.js` — new: reads `{code,args}` stdin, runs CJS, prints `{ok,result|error}`.
  (Copied into image build context or `docker cp`'d; shipped via `build:assets`.)

### 3. ToolContext — `tools/types.ts`
Add optional executor; absent ⇒ run on backend:
```
exec?: AgentExecutor   // present only when the running agent is isolated
```

### 4. Wire into AgentRunner
Before the tool loop, resolve `agent.isolation`. If `enabled`: `await
containerManager.ensureReady(agent)` and put the executor on every `ToolContext`. If not ready →
the tool call returns a hard error result (no backend fallback).

### 5. bash.ts + SkillRunner.ts
- `bash`: if `ctx.exec` → `ctx.exec.run(command,…)` (stream via `emitOutput`); else current spawn.
- `SkillRunner`: if `ctx.exec` → `runScript('node', transpiledJs, {args})` /
  `runScript('python3', source, {source,args})`; else current worker_thread / local python.
  Timeout + circuit breaker unchanged.

### 6. Routes — `isolation.routes.ts` (mounted at `/api/agents/:id/isolation`)
- `GET  /` → status (config + live container/image/volume state).
- `PUT  /` → update {enabled, dockerfile, cpus, memory, network, idle_timeout_ms}. On
  enable→noop build; on disable→teardown(container+image, keep volume).
- `POST /build` → **SSE** stream of build logs; sets `image_status` building→built|error.
- `POST /container/stop` → stop container.
- `DELETE /volume` → remove workspace volume (guard: container stopped).
- `DELETE /api/agents/:id` (existing) → extend to full teardown (container+image+volume).

### 7. env.ts
`DOCKER_BIN=docker`, `AGENT_IMAGE_PREFIX=pleiade_agent`,
`AGENT_CONTAINER_CPUS=1`, `AGENT_CONTAINER_MEMORY=1g`, `AGENT_CONTAINER_IDLE_MS=1800000`,
`AGENT_CONTAINER_NETWORK=bridge`.

## Docker / compose
- `backend/Dockerfile`: `apk add docker-cli`; ship harness files.
- `docker-compose.yml`: mount `/var/run/docker.sock` into backend (+ security comment).

## Frontend
- `lib/api.ts`: `Agent.isolation` type + `isolationApi` (get/update/build-SSE/stop/deleteVolume).
- `AgentsView.tsx`: "Isolation" section — enable toggle, Monaco Dockerfile editor, resource/network
  fields, **Build** button + streaming log panel, container status badge + Stop, **Delete volume**.

## Verification
- Toggle isolation on, edit Dockerfile, Build → logs stream, status→built.
- Agent `bash` runs inside its container (`hostname` differs from backend; installed pkg persists
  across calls; file in /workspace survives container restart).
- Python & TS skill execute in-container.
- Isolation on but not built → hard tool error.
- Disable → container+image gone, volume kept. Delete agent → volume gone too.
- Idle > timeout → container stops; next call restarts it, files intact.
