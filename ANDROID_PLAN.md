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

### Audio, and why the sockets are multiplexed

Audio is opt-in per device (`mirror_audio`). Turning it on adds a **third** scrcpy socket, and
scrcpy assigns roles purely by connection order — video, then audio, then control. That is what
forced the transport change: one `socat` per stream cannot express an ordering constraint, so
whichever container process happened to connect first became the video stream and a slow `docker
exec` would silently swap audio and control, corrupting every byte after it.

`MIRROR_MUX_SCRIPT` (planted Python, run over one `docker exec`) opens the sockets sequentially from
a single process — the listen backlog is FIFO, so connection order *is* accept order — and frames
them all onto one stdio pair as `[u8 stream][u32 BE length][payload]`, in both directions. Ordering
becomes correct by construction rather than by timing, which also retires the connect race the
earlier socat version had to retry around. Upstream scrcpy's own client connects sequentially from
one process for exactly this reason.

**The codec matters more than it looks.** scrcpy defaults to Opus; redroid has no Opus *encoder*, so
asking for it makes the server give up on audio entirely — it reports the failure in-band (a `0`
sentinel where the codec id belongs) and streams video only. That is the whole reason the earlier
sessions needed `--no-audio`. `mirror_audio_codec` therefore defaults to **AAC**, which has been a
mandatory Android encoder for years, and the parser turns both sentinels into an operator-facing
explanation instead of silence.

Browser side: the relay tags each packet with a kind byte, and `useAndroidMirror` feeds audio into a
WebCodecs `AudioDecoder` (`mp4a.40.2`, with the stream's first packet as the required
`AudioSpecificConfig` `description`). Decoded frames are scheduled onto the `AudioContext` clock a
fixed ~80 ms ahead rather than played on arrival — a live stream has no timeline, so the only thing
that matters is staying just far enough ahead to absorb jitter; the cursor is re-primed on underrun
and if the lead ever exceeds 500 ms, so latency cannot creep. Playback needs a user gesture
(autoplay policy), which is what the panel's Audio/Muted button is for.

### Rotation

The panel's rotate handles set the device's `user_rotation` over adb (`POST …/android/rotate`, step
or absolute) rather than sending scrcpy's own rotate message, which is only a toggle. Auto-rotate is
cleared first, since `user_rotation` is ignored while the sensor is in charge — without that the
button appears to do nothing. It rotates the **device**: an app that pins its own orientation, which
most games do, still wins.

The interesting consequence is on the *client*. Rotating re-announces the stream geometry —
608×1080 becomes 1080×608, carried as a fresh codec-config packet mid-session — so the decoder has
to be **reconfigured**, not merely fed the new SPS. `useAndroidMirror` therefore compares each config
packet against the one currently programmed in and reconfigures when it differs; the canvas resizes
from the decoded frame, and touch coordinates follow because they were always expressed in the video
frame's space.

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
- [x] **Verified against a live redroid 14 device** (2026-07-27), driving the adb protocol directly:
      - video prelude offsets, the config/key flag bits and the big-endian pts+length framing all
        parse cleanly (`h264`, 608×1080, SPS → `avc1.42C029`, then IDR + delta frames);
      - both control layouts land: a 14-byte `INJECT_KEYCODE` and a 32-byte `INJECT_TOUCH_EVENT`
        each visibly changed the device screen;
      - `uiautomator` returns a full hierarchy, so the structural tools work.
- [x] scrcpy server version pinned to **2.7** via the image's `SCRCPY_VERSION` build arg; the runtime
      reads the version back out of the image, so a bump is a one-arg change.

Three things that bit us on the first real run, all fixed:

1. **The relay connected before the server was listening.** `app_process` needs a second or two;
   connect early and adb accepts the TCP connection, fails to open the device-side stream and closes
   it, so the panel goes blank while the device-side log shows a healthy server waiting for a client
   that already gave up. The launch script now polls `/proc/net/unix` for `@scrcpy_<scid>`, and the
   relay retries a few times while nothing has been received.
2. **The stale-server sweep killed its own shell.** `pkill -f com.genymobile.scrcpy.Server` matches
   the command line of the very shell running it. Written `[c]om.genymobile…` it no longer does.
3. **A sleeping display captures as pure black** — both to `screencap` and to the encoder. Nothing
   was wrong with the device: Android's `screen_off_timeout` (121 s here) is far shorter than the gap
   between an agent's turns. The connect script now wakes the device when it reports itself asleep.

Also worth knowing: scrcpy's server **deletes its own jar** once loaded, so `/data/local/tmp` is
empty again next session. Pushing every session is required, not defensive.

A second pass over the prod logs (2026-07-27) found two more, both now fixed and verified:

4. **`android_app action=launch` never launched anything.** `monkey -p <pkg> -c …LAUNCHER 1` needs
   the device to report physical keys; on a headless one it aborts with `SYS_KEYS has no physical
   keys` and **exit 251** *after* printing its usual verbose banner, so the failure reads like a
   successful launch. Replaced with `cmd package resolve-activity --brief` + `am start -n`, which
   needs no input subsystem and names the component it started. A package with no launcher activity
   now gets a specific error instead of a generic one.
5. **`android_ui` failed on a sleeping screen, and `uiautomator dump` exits 0 when it fails** —
   printing `ERROR: null root node returned by UiTestAutomationBridge` and writing no file, so the
   exit code proves nothing and the file is the only real signal. The connect-time wake wasn't
   enough because readiness is cached for 60 s while the screen idles out at 121 s, i.e. within a
   single long turn. `KEYCODE_WAKEUP` now goes in at the point of use — `dumpUi`, `captureScreen`
   and `android_act` — where it costs nothing extra (same device shell) and also resets the idle
   timer, so a working agent keeps its screen alive.

`android_app action=current` was rewritten at the same time: it asked only for `mCurrentFocus` /
`mResumedActivity`, but `mCurrentFocus` is legitimately `null` mid-transition and Android 10+ renamed
the resumed field to `topResumedActivity`. It now asks the activity manager *and* the window manager
and returns both.
- [x] **Audio forwarding** (2026-07-28), opt-in per device, verified end-to-end against the same
      device through the *real* planted multiplexer: video 39 packets, audio 408 packets at
      `codec=aac` (2-byte AudioSpecificConfig then 341-byte frames), and a control key press visibly
      changing the screen — all three streams simultaneously and correctly demultiplexed.
      The browser-side `AudioDecoder` path is written but **not** browser-tested; everything up to
      the WebSocket is.
- [ ] Optional later: clipboard sync and multi-touch (the control protocol supports both; the panel
      deliberately implements neither yet).
