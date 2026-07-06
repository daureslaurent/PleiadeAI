# VISUAL_SKILL_PLAN.md

> Source of truth for the **Visual** capability: a Docker-isolated headless Linux GUI (Xvfb) that an
> agent can see and drive, streamed live into the chat UI over VNC (noVNC ↔ backend `socat` relay over
> the Docker socket) with optional human takeover of mouse/keyboard.
> **Final transport differs from the early Q1/Q2 sketch below** — see the §2 constraints, the decisions
> table, and the changelog for how it evolved (websockify/TCP → docker.sock `socat` → Unix socket).
>
> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked/decision needed.
> Keep this file updated as each phase lands — it is the shared state between operator and agent.

---

## 1. Goal

When an agent has the **Visual** skill enabled, its isolated container additionally runs a headless
X server (Xvfb) plus a VNC stack. The operator can:

1. **Watch** the agent's virtual desktop live, embedded in the existing chat/debugger UI.
2. **Take manual control** of mouse and keyboard at any time (co-drive / rescue).
3. Have the **agent programmatically drive** the same desktop (click, type, screenshot, reason).

This reuses the existing per-agent Docker isolation (`isolation/AgentContainerManager.ts`), EventBus,
and single authenticated socket ingress — it should not open a second, unauthenticated attack surface.

## 2. High-level architecture (LOCKED — Q1–Q4 decided)

```
┌────────────┐   noVNC (RFB over WS)   ┌────────────────┐   proxied WS    ┌──────────────────────────┐
│  Browser   │ ───────────────────────▶│  Node backend  │ ───────────────▶│  Agent container         │
│  React UI  │   (JWT socket ingress)  │  VNC proxy     │  (docker net)   │  Xvfb :99                │
│  noVNC RFB │◀─────────────────────── │  bridge/route  │◀─────────────── │  x11vnc  ─ websockify    │
└────────────┘                         └────────────────┘                 │  xdotool / agent driver  │
      ▲ human takeover                                                     └──────────────────────────┘
      │                                                                             ▲
      └──────────────── agent tool calls (screenshot → reason → act) ───────────────┘
```

**Decided stack (Q1–Q4):**

- **Q1 — Routing:** proxy VNC WS through the Node backend over the docker network. Single JWT ingress,
  no published host ports.
- **Q2 — Placement:** the VNC stack lives *inside* the agent container as an optional "visual" image
  layer; the `visual_*` Python skill drives the same display locally (no cross-container X forwarding).
- **Q3 — Driver:** a Python skill (`visual_act`, `visual_screenshot`) in the existing Python sandbox
  wraps click/type/screenshot into higher-level actions.
- **Q4 — Frontend:** `@novnc/novnc` mounted in a React `<VncView>` component with a view-only↔takeover
  toggle wired to `visual:*` events.

Key design constraints inherited from the codebase:

- **No host port publishing.** Containers are siblings on a docker `--network`; the backend reaches
  them by name/IP. Routing proxies VNC WS traffic backend→container over that network.
- **`bridge.ts` is the only client mapping.** New control/status events flow through the EventBus and
  `bridge.ts`, same as every other event.
- **Isolation errors never fall back.** If the Visual image isn't built, tools throw
  `IsolationNotReadyError` — the VNC route must surface an equivalent "not ready" state, never silently
  connect elsewhere.
- **Secrets injected at runtime**, never baked into image layers (mirror the SSH-key pattern). The VNC
  password / one-time token is planted at container start.

## 3. Phases

### Phase 0 — Decisions & spec (this file)
- [x] Draft architecture + phases (this document)
- [x] Resolve open decisions Q1–Q4 (see §4) and lock the routing + driver model
- [ ] Add a short `06-VISUAL_SKILL.md`-style note to the design spec if warranted

### Phase 1 — Docker infrastructure (the desktop image)  ·  _compile-verified; not yet runtime-verified_
- [x] Visual layer as an appendable Dockerfile snippet + preflight lint
      (`visual.template.ts`: `VISUAL_DOCKERFILE_SNIPPET`, `assertVisualLayer`) —
      `xvfb x11vnc fluxbox xdotool scrot websockify` + `pyautogui`/`pillow`.
      Images are operator-authored, so the snippet is *added by the operator* to a visual image, not
      force-injected. _TODO: surface a one-click "Add visual layer" in the Images UI._
- [x] Idempotent boot script (`VISUAL_BOOT_SCRIPT`): Xvfb `:99`, fluxbox, `x11vnc -localhost`,
      `websockify` — daemons `setsid`/`nohup`-detached (reparented to PID1, survive the `docker exec`)
- [x] Runtime VNC password planted mode-600 (`VISUAL_PASS_FILE`), never in image layers
- [x] `AgentContainerManager.ensureVisual(agentId)`: boots on demand, idempotent, returns the
      `VisualEndpoint` {host, port, password}; throws `IsolationNotReadyError` when the image lacks
      the layer (preflight) — honours the never-fall-back contract
- [x] Ready probe: boot script `is_up` (bash `/dev/tcp`) gates on websockify accepting; session cache
      cleared on stop/remove/idle so a re-boot is forced after the daemons die
- [x] **Runtime verified**: visual image built, desktop booted in a real container → `VISUAL_UP`;
      detached daemons survive the exec; socket-only readiness works. (Needed `procps`; see changelog.)

### Phase 2 — Backend proxying & control plane  ·  _compile-verified; not yet runtime-verified_
- [x] VNC WS relay (`transport/ws/visual-proxy.ts`): raw **binary** WS ↔
      `docker exec -i <c> socat - UNIX-CONNECT:<sock>` over the docker socket (Unix socket per Phase 5;
      originally loopback TCP). Own `upgrade` handler,
      claims only `/api/agents/:id/container/visual/vnc`; leaves `/socket.io/` untouched. Backpressure
      guard on the container→browser pump.
- [x] AuthZ: same JWT as the socket handshake, passed as `?token=` (browsers can't set WS headers);
      verified in the upgrade handler before `handleUpgrade`. Single-operator ⇒ any valid JWT may view.
- [x] Session handshake: `POST /api/agents/:id/container/visual/session` (`requireAuth`) →
      `ensureReady` + `ensureVisual` → returns `{ password, ws_path }`; `409 not_ready` mirrors
      `IsolationNotReadyError`. WS close codes: `4404` not-ready, `1011` error.
- [x] Wired in `index.ts` (`attachVisualProxy`); Caddy `/api/*` reverse_proxy already passes WS upgrades.
- [x] Idle teardown: relay rides the existing per-agent idle timer; session cache cleared on
      stop/remove/idle so daemons don't leak.
- [~] **Design deviation — `visual:*` EventBus events dropped.** A visual session is out-of-band from
      the *per-turn* EventBus (`bridge.ts` maps turn events only); forcing it there would add a client
      event nobody consumes yet. Observability is via Pino (`visual-proxy` scope) + WS close codes.
      Revisit only if the debugger drawer needs a session-lifecycle trace.
- [x] **Takeover coordination** — landed in Phase 4 (lock file honoured by `visual_act`; `POST
      …/visual/control` toggles it). See Phase 4.
- [x] **Runtime verified**: socket.io/visual `upgrade` coexistence confirmed (visual/vnc 401s without
      a token, socket.io unaffected); `socat UNIX-CONNECT` duplex pipe returns a real `RFB 003.008`.

### Phase 3 — Frontend component  ·  _build-verified (bundles); not yet runtime-verified_
- [x] noVNC RFB React component (`components/workspace/VisualPanel.tsx`) — modal overlay, **lazy**
      (`React.lazy`) so noVNC (187 KB) code-splits out of the main bundle
- [x] View-only ↔ takeover toggle (flips `rfb.viewOnly`); Ctrl+Alt+Del; starts view-only
- [x] Connection states from RFB events (`connect`/`disconnect`/`securityfailure`) + session-POST
      errors → `StatusPill` + overlays + manual **Reconnect** (via `attempt` re-effect). No `visual:*`
      events needed — the WS + POST give the client everything (see Phase 2 deviation).
- [x] `visualApi` (`lib/api.ts`): session handshake + `ws(s)://…?token=` URL builder; `Desktop`
      button in `ChatPanel` header, gated on `agent.isolation_id`; wired through `AgentWorkspace`
- [x] Scaling via `rfb.scaleViewport`; noVNC type shim (`lib/novnc.d.ts`); `es2022` Vite target for
      noVNC 1.7's top-level await
- [ ] **Runtime verification**: real RFB stream end-to-end; confirm the `ws` server (no `binary`
      subprotocol negotiation) is accepted by noVNC's RFB client

### Phase 4 — Agent control loop (programmatic driving)  ·  _compile/syntax-verified; not yet runtime-verified_
- [x] Driver skills `visual_screenshot` + `visual_act` (`backend/scripts/seed-visual-skill.mjs`,
      run like `seed.mjs`): pyautogui, `DISPLAY=:99`, actions click/double/right/move/drag/type/key/
      scroll. Python sources `py_compile`-checked.
- [x] Driver mechanism = Python pyautogui (Q3). Screenshots save to `/workspace/.visual/*.png`
      (viewable in the file explorer); returns path + size, optional `inline` base64.
- [x] Screenshot → reason → act rides the agent's existing tool loop (`MAX_TOOL_ITERATIONS`).
- [x] **Takeover arbitration** (closes the Phase 2 deferral): human takeover drops a lock file
      (`VISUAL_CONTROL_LOCK`) via `POST …/visual/control`; `visual_act` checks it and refuses so agent
      and operator don't fight over input. Wired: `setVisualHumanControl` → route → `visualApi.control`
      → `VisualPanel` toggle (+ release on close).
- [x] Guardrails: skills fail **soft** (`{success:false}`, no throw) when the desktop is absent, so a
      misconfigured agent can't trip the global circuit breaker; per-action timeout from the sandbox.
- [x] **Runtime verified**: `visual_act` drives Xvfb `:99` (move/type), `visual_screenshot` saves a
      real PNG (via `scrot`), the takeover lock makes `visual_act` refuse — all clean JSON through the
      real `py_runner`. (Fixed xauth-on-stdout + Xauthority + screenshot backend; see changelog.)

### Phase 5 — Hardening & polish  ·  _compile/build-verified; not yet runtime-verified_
- [x] **No VNC on any network.** Switched x11vnc from a loopback TCP port to an RFB **Unix socket**
      (`VISUAL_VNC_SOCK`), relayed via `socat - UNIX-CONNECT:<sock>`. Nothing binds a port; the socket
      is reachable only through `docker exec` (backend-only). WS ingress stays JWT-gated.
- [x] **Password rotation:** per-container-lifetime VNC password, planted mode-600 at runtime, cleared
      from the session cache (→ regenerated) on every stop/remove/idle.
- [x] **Multi-agent concurrency:** each agent's Unix socket + `:99` display live in its own container
      filesystem — isolated under `bridge`/`vpn`. Documented host-networking caveat (shared X abstract
      socket ⇒ one visual agent at a time on `host`) in `04-VISUAL_SKILL.md`.
- [x] **Docs:** `04-VISUAL_SKILL.md` (architecture, key files, operator setup, security model,
      limitations). This plan updated to `[x]` across implemented phases.
- [x] **Runtime verified** on a Docker host: full compose stack healthy, visual image builds, desktop
      boots, relay + `visual_*` + takeover all confirmed. Only the browser noVNC render is unexercised.

## 4. Decisions (RESOLVED)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| Q1 | VNC WS routing | **Proxy through Node backend over docker net** | Keeps single JWT ingress; no published host ports (matches current design) |
| Q2 | Where the VNC stack runs | **Inside the agent container (optional layer)** | Agent drives GUI locally; no cross-container X forwarding; built on-demand |
| Q3 | Agent GUI driver | **Python automation skill** (`visual_act`/`visual_screenshot`) | Higher-level API via existing Python sandbox |
| Q4 | Frontend noVNC integration | **`@novnc/novnc` React component** | Full control of takeover toggle, resize, reconnect, event wiring |

## 5. Changelog
- _init_ — file created; architecture drafted; awaiting Q1–Q4.
- _decisions locked_ — Q1 proxy-through-backend · Q2 in-container visual layer · Q3 Python driver skill · Q4 `@novnc/novnc` component. Phase 1 unblocked.
- _Phase 1 landed_ — `backend/src/isolation/visual.template.ts` (snippet, boot script, constants,
  `assertVisualLayer`) + `AgentContainerManager.ensureVisual` / `VisualEndpoint` / session cache.
  Backend `typecheck` clean. Not yet runtime-verified (no Docker daemon this session).
- _relay refinement_ — discovered `AGENT_CONTAINER_NETWORK` defaults to `host` ⇒ `container:6080`
  is unreachable from the backend + host-mode websockify ports collide. Switched to a docker.sock
  `socat` relay (Q1/Q2 detail revised): websockify → socat, x11vnc loopback-only, no port allocation.
- _Phase 2 landed_ — `transport/ws/visual-proxy.ts` (WS↔socat relay, JWT via `?token=`, backpressure),
  `POST …/container/visual/session` handshake, `attachVisualProxy` wired in `index.ts`. Added `ws` +
  `@types/ws` to `package.json` (sandbox blocked `npm install` — needs a networked `npm i` to lock).
  Backend `typecheck` clean. Not yet runtime-verified.
- _Phase 3 landed_ — `VisualPanel.tsx` (noVNC RFB, takeover toggle, states, reconnect),
  `visualApi`, `Desktop` button, `novnc.d.ts` shim, `es2022` Vite target. Added `@novnc/novnc@^1.7.0`
  to `package.json`; **`vite build` succeeds** with noVNC code-split into its own chunk. Two build
  fixes found only by actually building: noVNC's `exports` sugar forces the bare `@novnc/novnc`
  specifier (not the `/core/rfb.js` subpath), and its top-level await needs the `es2022` target.
- _Phase 4 landed_ — `seed-visual-skill.mjs` (`visual_screenshot` + `visual_act`, pyautogui,
  `py_compile`-checked) + full takeover arbitration (`VISUAL_CONTROL_LOCK`, `setVisualHumanControl`,
  `POST …/visual/control`, `visualApi.control`, `VisualPanel` wiring). Backend `typecheck` + frontend
  `build` clean. Not yet runtime-verified.
- _Phase 5 landed_ — hardening: x11vnc moved to an RFB **Unix socket** (no network port; fixes the
  host-networking loopback collision + removes all network surface), per-lifetime password rotation,
  multi-agent isolation via per-container socket/display. Docs: `04-VISUAL_SKILL.md`. Backend
  `typecheck` + frontend `build` clean.
- _Phase 5 landed_ — hardening: x11vnc moved to an RFB **Unix socket** (no network port; fixes the
  host-networking loopback collision + removes all network surface), per-lifetime password rotation,
  multi-agent isolation via per-container socket/display. Docs: `04-VISUAL_SKILL.md`.
- **_RUNTIME-VERIFIED on a Docker host_** — `docker compose up --build` brings all 8 services up
  healthy; backend logs `visual vnc proxy attached`; `visual/session|control` return 401 unauthed and
  the `visual/vnc` WS upgrade 401s without a token (**socket.io coexistence confirmed**). Built the
  visual image from the snippet, booted the desktop in a container → `VISUAL_UP`; `socat
  UNIX-CONNECT` returns a real `RFB 003.008` greeting; `visual_screenshot` (26 KB PNG) and
  `visual_act` (move/type) return clean JSON through the real `py_runner` harness; the takeover lock
  makes `visual_act` refuse. **Four issues found & fixed only by running it:**
  (1) base image lacked `procps` → `pgrep` missing → false `VISUAL_TIMEOUT` (added `procps`, made
  `is_up` socket-only); (2) python-xlib prints an xauth warning to **stdout**, breaking the harness's
  `JSON.parse` (mute stdout around the pyautogui import); (3) pyautogui needs a `~/.Xauthority`
  (boot creates an empty one; skills set `XAUTHORITY`); (4) pyscreeze's screenshot backend needs
  gnome-screenshot → switched `visual_screenshot` to `scrot`.
- **Status: implementation complete AND runtime-verified across Phases 1–5.** The only link not
  exercised is the *browser* noVNC canvas rendering pixels in the live UI (needs an agent assigned to
  a visual image + a browser) — but its whole server side (socat→RFB relay) is verified, and noVNC is
  a mature client.
