# Android control plan — `android_*` tools

Give an agent a phone the way it already has a desktop: the agent sees an Android screen and drives
it. Mirrors the visual-desktop design (`VISUAL_SKILL_PLAN.md`, `isolation/visual.template.ts`,
`tools/core/visual.ts`) but replaces pixel-hunting with Android's own structural interfaces.

## 1. Why not "just reuse `visual_*`"

An emulator window on `:99` would work with the existing visual tools unchanged — but the agent
would then locate widgets with the vision model + OCR snap + affine click calibration, inheriting
every source of error that stack exists to paper over.

Android exposes something X11 does not: `uiautomator dump` returns the **full view hierarchy with
exact pixel bounds, `resource-id`, `text` and `content-desc` for every widget**. That is a
structural locator — the role `visual_windows` plays for windows, but for every control on screen.
So:

- **locating** is exact and free (`android_ui`) — no vision model, no OCR, no calibration;
- **acting** is deterministic (`adb shell input`);
- **vision is used only for what it's good at**: reading/describing a screen (`android_screenshot`).

Plus capabilities vision can never provide: install an APK, launch an activity, read `logcat`,
enumerate packages.

## 2. Device backend

The tools speak **only `adb`**, so the device on the other end is swappable without touching them.

**Host capability, measured on the prod OVH box (2026-07-26):**

```
/dev/kvm       crw-rw---- 1 root kvm      → present, nested virtualization works
binder_linux   not found in 6.8.0-134-generic
uname -r       6.8.0-134-generic
```

So:

- **an AVD emulator (topology A) — viable, and the chosen path.** `/dev/kvm` is there.
- **redroid — ruled out.** No `binder_linux` module on this kernel.
- **a physical device** — `adb connect <ip>:5555`, still supported by leaving the AVD name empty.

### Topology A — all-in-one image (built)

The emulator lives in the agent's **own** container, configured entirely from the Images page: tick
**Android** → **Run the emulator in this container**, which appends the SDK/AVD layer to the
Dockerfile, then tick **Hardware acceleration** on the isolation profile.

Two things in the existing container lifecycle had to change for this to work at all:

1. `docker.service.createContainer` nulls the image entrypoint (`--entrypoint '' … tail -f
   /dev/null`), so an image that would normally boot an emulator from its ENTRYPOINT boots into
   nothing. `androidEmulatorScript` starts it on demand instead — detached with `setsid`/`nohup`,
   idempotent, judged by the live process rather than a leftover file, exactly like the visual
   stack's daemons.
2. `createContainer` passed no `--device`, so `/dev/kvm` could never reach an agent container. It
   now takes a `devices` list, driven by a `kvm` flag on the isolation profile (which also forces a
   container recreate, since it's a create-time flag).

Still gated on the host actually having `/dev/kvm`: without it `docker create` fails outright, and
the launch script warns (`ANDROID_NO_KVM`) if the device is missing at run time.

### Topology B — device sidecar (ruled out on this host; kept for reference)

Would apply if a future host lacked `/dev/kvm` but could load `binder_linux`. redroid cannot run
inside the agent container, so it becomes a **per-profile sidecar** — exactly the pattern
`vpn.service.ts` / `docker.service.createGluetun()` already implement for gluetun:

- `isolation/redroid.service.ts` ← mirrors `vpn.service.ts`
- `docker.service.createRedroid()` ← mirrors `createGluetun()` (`--privileged` where that has
  `--cap-add NET_ADMIN`)
- the agent container joins the sidecar's network namespace (the mechanism `network: 'vpn'` uses),
  so `adb connect 127.0.0.1:5555` works and nothing binds on a public port.
- **Watching it live:** run `scrcpy` on `:99` in a visual-layer agent image, pointed at the
  sidecar's adb. The existing noVNC panel then shows the live phone and allows manual takeover —
  zero new transport or frontend code.

(One refinement topology A still lacks: the AVD lives in the image layer, so a container rebuild
re-cold-boots it. A dedicated volume for `$ANDROID_AVD_HOME` would persist device state across
rebuilds.)

## 3. Phase A — the tools

Image layer (`isolation/android.template.ts`, mirrors `visual.template.ts`):

- `ANDROID_DOCKERFILE_SNIPPET` — `adb`, `scrcpy`, `python3-pil` (thumbnails). A few MB, *not* the
  10 GB SDK; the device lives elsewhere.
- `assertAndroidLayer(dockerfile)` — best-effort lint, mirrors `assertVisualLayer`.
- `ANDROID_CONNECT_SCRIPT` — idempotent: start the adb server, `adb connect` a TCP serial, wait for
  the device and for `sys.boot_completed`. Contract markers on stdout/stderr:
  `ANDROID_UP` / `ANDROID_ALREADY_UP` / `ANDROID_NO_ADB` / `ANDROID_NOT_BOOTED` / `ANDROID_TIMEOUT`.

Readiness lives in `tools/core/android.ts` (an in-process per-agent cache + the idempotent script),
not in `AgentContainerManager` — unlike the visual desktop there is no relay endpoint to hand back,
so the extra plumbing would buy nothing.

| Tool | Backing | Purpose |
|---|---|---|
| `android_ui` | `uiautomator dump` | The locator. Flat list of widgets: `text`, `resource_id`, `class`, `content_desc`, `clickable`, `bounds`, `center`. Optional substring `filter`. **Exact coordinates, no vision.** |
| `android_screenshot` | `adb exec-out screencap -p` | Read/describe a screen via the Vision endpoint. Describe-mode only — locating is `android_ui`'s job, so no grid, no OCR, no calibration. |
| `android_act` | `adb shell input` | `tap`, `long_press`, `swipe`, `type`, `key`, `back`, `home`, `recents`. Accepts **either** `x`/`y` **or** `target` (a text/id substring resolved through `android_ui`) — the ergonomic win: `android_act({action:'tap', target:'Sign in'})` is pixel-exact with no vision in the loop. |
| `android_app` | `pm` / `am` / `dumpsys` | `list`, `launch`, `stop`, `install`, `current`. |

Wiring (each mirrors the `visual` flag's existing path):

- `tools/registry.ts` — `ANDROID_TOOL_NAMES` + register the four tools.
- `domain/images/image.model.ts` — `android: Boolean` + `android_adb_serial: String` (+ migration).
- `orchestrator/AgentRunner.ts` — auto-grant `ANDROID_TOOL_NAMES` when `image.android`.
- Frontend — an "Android" toggle on the Images page; chat cards reuse `emitVision` / `emitVisualAct`,
  so there is **no new frontend event work**.

## 4. Status

- [x] Phase A — backend-agnostic `android_*` tools (this document). Backend + frontend typecheck
      clean; **not yet exercised against a real device** — there isn't one to point at until Phase B.
- [x] Host verified on prod: `/dev/kvm` present, `binder_linux` absent (2026-07-26)
- [x] Topology A — all-in-one emulator image (`/dev/kvm` passthrough + on-demand emulator launch).
      Typechecks and builds; **unverified against a running emulator.**
- [ ] Build the image on prod and drive a real screen end-to-end — the first genuine test of the adb
      plumbing, the `uiautomator` parsing and the launch script's readiness contract
- [ ] Optional: persist `$ANDROID_AVD_HOME` on a volume so device state survives container rebuilds
- [~] Topology B — redroid sidecar: ruled out on this host (no `binder_linux`)

Files touched in Phase A:

- `backend/src/isolation/android.template.ts` (new) — Dockerfile snippet, lint, connect script
- `backend/src/tools/core/android.ts` (new) — the four tools
- `backend/src/tools/registry.ts` — `ANDROID_TOOL_NAMES` + registration
- `backend/src/tools/core/guide.ts` — `android` topic guide + `android_ui` tool guide
- `backend/src/orchestrator/AgentRunner.ts` — auto-grant on `image.android`
- `backend/src/domain/images/image.model.ts` + `migrations/20260725230000-image-android-layer.js`
- `backend/src/transport/http/routes/images.routes.ts` — field whitelist + lint
- `frontend/src/views/ImagesView.tsx` — Android section/toggle + adb serial field
- `frontend/src/lib/api.ts`, `frontend/src/lib/toolSummary.ts` — types + debugger cards

Topology A adds:

- `backend/src/isolation/android.template.ts` — emulator Dockerfile snippet + launch script
- `backend/src/isolation/docker.service.ts` — `devices` → `--device`
- `backend/src/isolation/AgentContainerManager.ts` — pass `/dev/kvm` when the profile asks
- `backend/src/domain/isolations/isolation.model.ts` — `kvm` flag
- `backend/src/domain/images/image.model.ts` — `android_emulator_avd`
- `backend/migrations/20260725234500-android-in-container-emulator.js`
- `backend/src/transport/http/routes/{images,isolations}.routes.ts` — whitelists + recreate trigger
- `frontend/src/views/{ImagesView,IsolationsView}.tsx` — emulator layer + KVM toggle
