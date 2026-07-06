# 04 — Visual Skill (live agent desktop)

The **Visual** capability gives an isolated agent a headless Linux desktop it can *see* and *drive*,
streamed live into the chat UI so the operator can watch and take manual control. Implementation
tracking lives in `VISUAL_SKILL_PLAN.md`; this file is the durable operator + architecture reference.

## Architecture

```
┌────────────┐   RFB over WS    ┌────────────────┐   docker exec    ┌────────────────────────────┐
│  Browser   │ ───────────────▶ │  Node backend  │ ───────────────▶ │  Agent container (isolated) │
│ noVNC RFB  │   JWT ?token=    │  visual-proxy  │  socat over      │   Xvfb :99 + fluxbox        │
│ (VncView)  │ ◀─────────────── │  (ws upgrade)  │  docker.sock     │   x11vnc → RFB Unix socket  │
└────────────┘                  └────────────────┘                  │   visual_* skill (pyautogui)│
      ▲ takeover                                                     └────────────────────────────┘
      └───────────────── agent: visual_screenshot → reason → visual_act ─────────────┘
```

Design decisions (see `VISUAL_SKILL_PLAN.md` §2/§4 for the trade-offs):

- **In-container desktop.** The Xvfb/x11vnc stack runs inside the agent's *existing* isolated
  container, planted and booted on demand like the skill harnesses — never baked into an image
  entrypoint. So the `visual_*` skill drives the same display locally, no cross-container X forwarding.
- **Relay over the Docker socket, not the network.** x11vnc serves RFB on a **Unix socket**
  (`/opt/pleiade/visual/vnc.sock`) — no TCP port on any network. The backend streams it with
  `docker exec -i <c> socat - UNIX-CONNECT:<sock>`, so the relay is identical under `host`, `bridge`,
  and `vpn` network modes and can never collide on a port.
- **Single authenticated ingress.** The browser's noVNC opens a raw binary WebSocket at
  `/api/agents/:id/container/visual/vnc?token=<jwt>`; `transport/ws/visual-proxy.ts` claims only that
  path (leaving socket.io's `/socket.io/` untouched) and verifies the JWT before relaying.

## Key files

| Concern | File |
|---|---|
| Desktop layer snippet, boot script, constants, lint | `backend/src/isolation/visual.template.ts` |
| Boot-on-demand, VNC password, takeover lock | `backend/src/isolation/AgentContainerManager.ts` (`ensureVisual`, `setVisualHumanControl`) |
| WS↔socat relay | `backend/src/transport/ws/visual-proxy.ts` |
| Session + control HTTP routes | `backend/src/transport/http/routes/agent-container.routes.ts` (`/visual/session`, `/visual/control`) |
| Driver tools (built-in) | `backend/src/tools/core/visual.ts` (`visual_screenshot`, `visual_act`, `visual_windows`), registered in `tools/registry.ts` |
| Frontend panel + client | `frontend/src/components/workspace/VisualPanel.tsx`, `frontend/src/lib/api.ts` (`visualApi`) |

## Operator setup

1. **Build a visual image.** On the Images page, create/edit an image and flip the **Visual desktop**
   toggle. It injects the visual layer (`VISUAL_DOCKERFILE_SNIPPET` in `visual.template.ts` — `xvfb
   x11vnc fluxbox xdotool scrot socat` + `pyautogui`/`pillow`) into the Dockerfile, which you can
   still edit, and flags the image `visual`. Build it.
2. **Point an isolation profile at that image**, and assign the agent to the profile. For **concurrent**
   visual agents use `bridge`/`vpn` network mode (see Limitations).
3. **Nothing to seed.** `visual_screenshot` / `visual_act` are built-in core tools, auto-granted to any
   agent whose isolation image is flagged `visual` (no `tools_allowed` entry needed). They can still
   be globally disabled from the Tools page.
4. **Watch / drive.** In the agent workspace, click **Desktop** (shown when the agent is isolated).
   The panel opens view-only; **Take control** flips to interactive (and pauses the agent's driver).

## Security model

- No VNC port is exposed on any network — RFB is a container-filesystem Unix socket reachable only via
  `docker exec` (i.e. only the backend, which holds the Docker socket).
- The WebSocket relay requires a valid JWT (same secret as the socket.io handshake).
- x11vnc is additionally password-protected; the password is generated per container lifetime, planted
  mode-600 at runtime (never in image layers), and rotates whenever the container restarts.
- Human takeover writes `/opt/pleiade/visual/human_control`; `visual_act` refuses while it exists, so
  the agent and operator never fight over input.

## Limitations / notes

- **Concurrent visual agents need per-container network isolation.** The X display is fixed at `:99`
  (so the driver skills can hard-code `DISPLAY`). Under `--network host` the X server's abstract socket
  is shared across containers, so two visual agents on `:99` collide — run them on `bridge`/`vpn`
  network mode (recommended for isolation anyway), where each container has its own namespaces.
- **Seeing screenshots requires a vision model.** `visual_screenshot` saves a PNG under
  `/workspace/.visual` and returns it inline as an image block (plus path + pixel size). A text-only
  inference model can act on coordinates but cannot *see* the image. Because vision capability can't
  be autodiscovered from `/v1/models`, mark the endpoint **Model supports vision** (Settings →
  Endpoints; `supports_vision` on the endpoint). A visual agent paired with an unmarked endpoint shows
  a warning in its model selector, `visual_screenshot` returns a `note` in its result, and the backend
  logs `prompt carries images but endpoint is not marked vision-capable`. The llama.cpp server must be
  launched with `--mmproj <projector>` and a vision GGUF (Qwen2.5-VL, Llava, MiniCPM-V, …).
- The desktop boots lazily on first `Desktop` open / first `visual_*` call and idle-stops with the
  container.
