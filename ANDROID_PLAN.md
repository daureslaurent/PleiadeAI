# Android agents — `android_*` tools + the live phone mirror

Give an agent a phone the way it already has a desktop: the agent drives an Android device, and the
operator watches — and can take over — from the Workspace. Mirrors the visual-desktop design
(`VISUAL_SKILL_PLAN.md`, `isolation/visual.template.ts`, `tools/core/visual.ts`) everywhere the
shape is genuinely the same, and diverges deliberately in two places.

## 1. Topology

The device is **external**: an emulator (or physical phone) listening for `adb connect` on a TCP
port somewhere the agent containers can route to. It is registered once in
`android_devices` (Settings → Connections) and linked per agent.

```
browser ──WS──► backend ──docker exec socat──► agent container ──adb──► device (host:5555)
                                                    │
                                                    └── android_* tools also run here
```

`adb` runs **inside the agent's container**, not in the backend. That is the same seam `bash`, the
file tools and skills already funnel through (`AgentExecutor`), so a `vpn`-mode profile reaches the
device through its tunnel and a `bridge`-mode one through the Docker network, with no second network
policy to reason about. The consequence to remember: an address like `127.0.0.1` means *the
container*, so an emulator on the Docker host is usually `172.17.0.1:5555` or a LAN address.

`ssh`-mode profiles are refused for the mirror: the agent's tools would run adb on the remote host
while the relay streams out of the container, so the operator would be watching a different device
than the agent is driving.

## 2. Why not "just reuse `visual_*`"

An emulator window on `:99` would work with the existing visual tools unchanged — but the agent
would then locate widgets with the vision model + OCR snap + affine click calibration, inheriting
every source of error that stack exists to paper over.

Android exposes something X11 does not: `uiautomator dump` returns the **full view hierarchy with
exact pixel bounds, `resource-id`, `text` and `content-desc` for every widget**. So:

- **locating** is exact and free (`android_ui`) — no vision model, no OCR, no calibration;
- **acting** is deterministic (`adb shell input`);
- **vision is used only for what it's good at**: reading/describing a screen (`android_screenshot`).

Plus capabilities vision can never provide: install an APK, launch an activity, read `logcat`,
enumerate packages, move files on and off the device.

## 3. The tools

`tools/core/android.ts`. Auto-granted by `AgentRunner` when the agent has an `android_device_id` —
note the trigger is the **device link**, not an image flag as with `visual`: one Android image serves
any number of agents each pointed at a different phone, which an image flag cannot express.

| Tool | Backing | Purpose |
|---|---|---|
| `android_ui` | `uiautomator dump` | The locator. Widgets with `text`, `resource_id`, `class`, `content_desc`, `clickable`, exact `bounds` + `center`. Optional ranked `filter`. |
| `android_screenshot` | `screencap` + Vision endpoint | Read/describe a screen. Describe-mode only — locating is `android_ui`'s job. |
| `android_act` | `adb shell input` | `tap`, `long_press`, `swipe`, `type`, `key`, `back`, `home`, `recents`. Takes coordinates **or** a `target` description resolved through the view hierarchy; a miss returns the widgets that *are* on screen rather than failing blind. |
| `android_app` | `pm` / `am` / `dumpsys` | `list`, `launch`, `stop`, `install`, `uninstall`, `current`. |
| `android_shell` | `adb shell` | The escape hatch: `settings`, `dumpsys`, `wm`, `getprop`, `content`… Runs on the **device**, not in the agent's container. |
| `android_logcat` | `logcat -d` | Why something failed, when the screen doesn't say. Tag/priority/substring filters, or clear-then-reproduce. |
| `android_file` | `adb push` / `pull` | The bridge between the agent's own filesystem and the phone's — sideload an APK, retrieve a produced file. |

Chat cards reuse `emitVision` / `emitVisualAct`, so there is no new event plumbing; the "snapped to"
chip is repurposed to show which widget a `target` resolved to.

## 4. The live mirror

There is no VNC server on a phone, so the picture comes from **scrcpy**: a ~70 kB server jar pushed
to the device, which encodes the screen to H.264 and listens on an abstract socket there. Only the
server is installed — never the desktop scrcpy client, which is why it doesn't matter that Debian
bookworm has no `scrcpy` package.

```
scrcpy-server (on device) ──localabstract──► adb forward tcp:N (agent container)
                                                   │
                              docker exec socat ×2 ─┤ video socket  → WS binary → WebCodecs → canvas
                                                    └ control socket ← WS JSON  ← pointer/keyboard
```

- `isolation/android.template.ts` — the image layer, the connect script, the scrcpy launch script.
- `isolation/scrcpy.ts` — the wire protocol: video framing parser + control-message encoder. The one
  version-specific binary layout lives here, next to the version the image pins.
- `transport/ws/android-proxy.ts` — the relay, mirroring `visual-proxy.ts`: same `docker exec socat`
  trick over the Docker socket the backend already owns, so **no port is published on any network**
  and the relay is network-mode agnostic.
- `components/workspace/useAndroidMirror.ts` — WS → `VideoDecoder` → canvas, plus input capture.

Three decisions worth recording:

1. **Socket ordering is enforced, not hoped for.** scrcpy hands the first connection to video and the
   second to control. The relay only opens the control connection *after* the first byte arrives on
   the video socket (scrcpy's dummy handshake byte), so a slow `docker exec` cannot swap them.
2. **Input is encoded backend-side.** The browser sends `{t:'touch',action,x,y,w,h}`; the backend
   turns that into scrcpy's binary control messages. The fragile layout stays in one typed file and
   never leaks into the frontend.
3. **`adb forward tcp:0`** lets adb allocate the port and print it, which sidesteps collisions between
   agents — including under `--network host`, where every agent container shares the host netns and a
   fixed port would clash.

Coordinates travel in the *video frame's* space; scrcpy rescales to the real screen. That is what
lets `mirror_max_size` reduce bandwidth without costing any accuracy.

**Human takeover** mirrors the desktop's contract: taking control drops `/workspace/.android/human_control`
in the container, which `android_act` checks and stands down against, so the agent and the operator
never fight over the touchscreen. The panel starts view-only and releases control on unmount.

Browser support: the mirror needs WebCodecs (Chrome, Edge, Safari 16.4+). Firefox has no
`VideoDecoder` yet and is told so explicitly rather than showing a black canvas.

## 5. Wiring

| Concern | Where |
|---|---|
| Device registry | `domain/android-devices/` (+ `adb-probe.ts`), `transport/http/routes/android-devices.routes.ts` |
| Settings UI | `views/settings/managers/AndroidDevicesManager.tsx`, in the Connections panel |
| Image layer | `image.android` flag + `isolation/android.template.ts`; "Android control" toggle on the Images page |
| Agent link | `agent.android_device_id`; `views/AgentAndroidSelect.tsx` on the Agents page |
| Tool grant | `tools/registry.ts` (`ANDROID_TOOL_NAMES`) + `AgentRunner` |
| Mirror session | `AgentContainerManager.ensureAndroidMirror` / `cleanupAndroidMirror` / `setAndroidHumanControl` |
| Chat entry point | `ChatPanel` "Phone" button (gated on the computed `agent.android`), `AndroidPanel`, `/phone/:agentId` |
| Migration | `migrations/20260727120000-android-devices.js` |
| Agent guide | `tools/core/guide.ts` → `android` topic |

The `adb-probe.ts` handshake deserves a note: the backend has no `adb`, so "Test connection" speaks
just enough of the adb transport protocol itself (a `CNXN` packet) to tell three genuinely different
failures apart — nothing listening, not-actually-adb, and "device requires RSA authorisation". It
runs from the *backend* container, so its verdict is advisory about what the agent's container sees.

## 6. Status

- [x] Device registry + Settings UI + adb probe
- [x] Image layer (adb + socat + pinned scrcpy-server) + Dockerfile lint + Images toggle
- [x] Agent device link + auto-granted tools + agent-form preflight warnings
- [x] Seven `android_*` tools + guide topic + debugger cards
- [x] scrcpy relay (video + control) and the WebCodecs mirror panel, inline and popped-out
- [x] Backend + frontend typecheck and build clean
- [ ] **Not yet exercised against a running device.** Everything below is unverified end-to-end:
      the `uiautomator` parsing, the scrcpy handshake/framing, and the control-message layouts.
- [ ] scrcpy server version is pinned to **2.7** via the image's `SCRCPY_VERSION` build arg. If the
      protocol turns out to disagree, bump that arg — the runtime reads the version back out of the
      image, so nothing else needs changing.
- [ ] Optional later: audio, clipboard sync, multi-touch (the control protocol supports all three;
      the panel deliberately implements none of them yet).
