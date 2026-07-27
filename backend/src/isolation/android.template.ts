/**
 * Android control layer: the agent drives a registered Android device (`android_devices`) over `adb`
 * from inside its own isolated container, and the operator watches the same screen live in the
 * Workspace over scrcpy. Mirrors `visual.template.ts` — an opt-in Dockerfile snippet, a best-effort
 * lint, and idempotent scripts fed to `bash` in the container.
 *
 * Why the container and not the backend: `adb` runs where the agent's `bash`, files and skills run,
 * so a `vpn`-mode profile reaches the device through its tunnel and a `bridge`-mode one through the
 * Docker network, with no second network policy to reason about. Everything funnels through the one
 * `AgentExecutor`, exactly as `SSH_ISOLATION_PLAN.md` describes for remote execution.
 *
 * The image installs only the ~10 MB `adb` client plus a pinned `scrcpy-server.jar` — never the
 * Android SDK. *Where* Android actually runs is the device registry's business, and the tools speak
 * only adb, so an emulator, a redroid container or a physical phone are interchangeable.
 */

/** Where the layer's runtime assets land in the image. */
export const ANDROID_DIR = '/opt/pleiades/android';
/** The scrcpy server jar pushed to the device to start mirroring. */
export const SCRCPY_JAR = `${ANDROID_DIR}/scrcpy-server.jar`;
/**
 * The jar's version string, written at build time. scrcpy's server refuses to start unless the
 * version passed on its command line matches the jar exactly, so we read it back at runtime instead
 * of hard-coding it here — bumping `SCRCPY_VERSION` in the Dockerfile is then the only change needed.
 */
export const SCRCPY_VERSION_FILE = `${ANDROID_DIR}/scrcpy-version`;
/** Where the jar is pushed on the device (scrcpy's own conventional path). */
export const SCRCPY_DEVICE_JAR = '/data/local/tmp/scrcpy-server.jar';
/** Logs + state for the android layer, inside the agent's workspace so the operator can read them. */
export const ANDROID_LOG_DIR = '/workspace/.android';
/**
 * Presence of this file means a human has taken manual control through the Workspace mirror; the
 * `android_act` tool checks for it and refuses to act, so the agent and the operator don't fight
 * over the touchscreen. Mirrors `VISUAL_CONTROL_LOCK`.
 */
export const ANDROID_CONTROL_LOCK = `${ANDROID_LOG_DIR}/human_control`;

/** How long `ensureAndroid` waits for the device to appear *and* finish booting. */
export const ANDROID_BOOT_TIMEOUT_S = 60;

/**
 * Dockerfile snippet provisioning the Android layer. Appended by the operator to an "android" image
 * from the Images page (images are user-authored). One `RUN` so it is a single cache layer.
 *
 * - `adb` is the entire control surface for the tools.
 * - `socat` is what the backend's mirror relay `docker exec`s into, exactly as the visual layer does.
 * - `scrcpy-server.jar` is downloaded from the pinned release — only the *server* (a ~70 kB jar that
 *   runs on the device), never the desktop scrcpy client, which is why it doesn't matter that Debian
 *   bookworm has no `scrcpy` package.
 * - `python3-pil` backs the screenshot thumbnails shown on the chat cards.
 *
 * Bump `SCRCPY_VERSION` to move to a newer server; the runtime reads the version back from the image
 * so nothing else needs to change.
 */
export const ANDROID_DOCKERFILE_SNIPPET = `# --- PleiadesAI android layer (adb control + scrcpy mirroring of a registered device) ---
ARG SCRCPY_VERSION=2.7
RUN apt-get update && apt-get install -y --no-install-recommends \\
      adb socat curl ca-certificates \\
      python3 python3-pil \\
    && mkdir -p ${ANDROID_DIR} \\
    && curl -fsSL -o ${SCRCPY_JAR} \\
         "https://github.com/Genymobile/scrcpy/releases/download/v\${SCRCPY_VERSION}/scrcpy-server-v\${SCRCPY_VERSION}" \\
    && echo "\${SCRCPY_VERSION}" > ${SCRCPY_VERSION_FILE} \\
    && rm -rf /var/lib/apt/lists/*`;

/** Runtime binaries the connect script preflights on; a missing one means the image lacks this layer. */
const ANDROID_BINARIES = ['adb', 'socat'] as const;

/**
 * Best-effort static lint (mirrors `assertVisualLayer`): warn when an image's Dockerfile is unlikely
 * to provide the Android layer. Heuristic guidance, not a hard block — the connect script's preflight
 * remains authoritative.
 */
export function assertAndroidLayer(dockerfile: string): string[] {
  const text = dockerfile.toLowerCase();
  const warnings: string[] = [];
  for (const bin of ANDROID_BINARIES) {
    // `adb` is a substring of plenty of unrelated words, so require it as a standalone token.
    if (!new RegExp(`(^|[^a-z0-9_-])${bin}([^a-z0-9_-]|$)`).test(text)) {
      warnings.push(
        `Image Dockerfile does not appear to install "${bin}" — the android_* tools will not work. Add the Android layer snippet.`,
      );
    }
  }
  if (!text.includes('scrcpy-server')) {
    warnings.push(
      'Image Dockerfile does not appear to fetch scrcpy-server — the live phone mirror in the Workspace will not start. Add the Android layer snippet.',
    );
  }
  return warnings;
}

/**
 * Shell-quote a value for safe interpolation into a generated script. These values come from
 * operator config, so they are not hostile — but splicing them raw into a command line would be
 * sloppy, and a device name with a space would silently break the script.
 */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Idempotent connect/readiness script. Starts the adb server, `adb connect`s the device's TCP serial,
 * then waits for it to be listed *and* for `sys.boot_completed` — a device that answers adb but is
 * still booting fails every `input`/`uiautomator` call in a way that looks like a tool bug.
 *
 * Contract (parsed by `ensureAndroid`):
 *  - exit 0 + `ANDROID_ALREADY_UP` / `ANDROID_UP` on stdout → the device is connected and booted
 *  - exit 3 + `ANDROID_NO_ADB` on stderr                    → image lacks the Android layer
 *  - exit 4 + `ANDROID_NO_DEVICE` on stderr                 → nothing answered at that serial
 *  - exit 6 + `ANDROID_UNAUTHORIZED` on stderr              → adbd answered but demands RSA approval
 *  - exit 1 + `ANDROID_NOT_BOOTED` on stderr                → reachable but never finished booting
 */
export function androidConnectScript(serial: string): string {
  return `#!/usr/bin/env bash
# PleiadesAI android connect — idempotent. Safe to call before every tool invocation.
set -u

SERIAL=${sq(serial)}
DEADLINE=${ANDROID_BOOT_TIMEOUT_S}

command -v adb >/dev/null 2>&1 || { echo "ANDROID_NO_ADB" >&2; exit 3; }

booted() {
  [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r\\n')" = "1" ]
}

# A sleeping display captures as a pure-black screenshot and encodes as a black video stream — the
# device is fine, there is simply nothing lit to capture. Android dims out after its
# \`screen_off_timeout\` (two minutes on a stock image), which is far shorter than the gaps between an
# agent's turns, so *most* captures would be black without this. Idempotent and cheap: we only send
# the wake key when the device says it is actually asleep.
wake() {
  case "$(adb -s "$SERIAL" shell dumpsys power 2>/dev/null | grep -m1 'mWakefulness=')" in
    *Awake*) : ;;
    *) adb -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true ;;
  esac
}

# Fast path: already connected and booted — the common case, so it must stay cheap.
if booted; then wake; echo "ANDROID_ALREADY_UP"; exit 0; fi

adb start-server >/dev/null 2>&1

# A TCP serial (host:port) needs an explicit connect; a USB/emulator serial is picked up by the server.
case "$SERIAL" in
  *:*) adb connect "$SERIAL" >/dev/null 2>&1 || true ;;
esac

# Wait for the device to be listed at all before waiting on the boot property, so an unreachable
# device is reported as "no device" rather than as a boot timeout.
for _ in $(seq 1 20); do
  if adb devices | grep -q "^$SERIAL[[:space:]]"; then break; fi
  case "$SERIAL" in *:*) adb connect "$SERIAL" >/dev/null 2>&1 || true ;; esac
  sleep 0.5
done

# "unauthorized" is its own failure: adbd is answering, but the device has not approved this host's
# key. No amount of waiting fixes it, so fail fast with the one instruction that does.
if adb devices | grep -q "^$SERIAL[[:space:]]\\+unauthorized"; then
  echo "ANDROID_UNAUTHORIZED" >&2
  exit 6
fi

if ! adb devices | grep -q "^$SERIAL[[:space:]]\\+device"; then
  echo "ANDROID_NO_DEVICE" >&2
  exit 4
fi

for _ in $(seq 1 "$DEADLINE"); do
  if booted; then wake; echo "ANDROID_UP"; exit 0; fi
  sleep 1
done

echo "ANDROID_NOT_BOOTED" >&2
exit 1
`;
}

/**
 * Turn a connect-script failure marker into an operator-actionable sentence. Shared by the tools and
 * by the mirror relay so both name the same cause the same way.
 */
export function androidConnectFailure(stderr: string, serial: string): string {
  if (stderr.includes('ANDROID_NO_ADB')) {
    return "This agent's Docker image has no `adb`. Open the Images page, enable the Android control toggle on its image, and rebuild.";
  }
  if (stderr.includes('ANDROID_UNAUTHORIZED')) {
    return `The device at ${serial} is refusing this host's adb key ("unauthorized"). Accept the "Allow USB debugging" prompt on the device, or run the emulator with adb authorisation disabled.`;
  }
  if (stderr.includes('ANDROID_NO_DEVICE')) {
    return `No Android device answered at ${serial}. Check that the emulator is running and that this address is reachable from the agent's container — note that 127.0.0.1 means the container itself, so an emulator on the Docker host usually needs its bridge-gateway or LAN address instead.`;
  }
  if (stderr.includes('ANDROID_NOT_BOOTED')) {
    return `The Android device at ${serial} is reachable but never finished booting (sys.boot_completed never became 1).`;
  }
  return `Could not reach the Android device at ${serial}: ${stderr.trim() || 'unknown error'}`;
}

/** Same, for the scrcpy launch script's markers. */
export function scrcpyFailure(stderr: string): string {
  if (stderr.includes('SCRCPY_NO_JAR')) {
    return "This agent's Docker image has no scrcpy-server jar, so the live mirror cannot start. Enable the Android control toggle on its image and rebuild.";
  }
  if (stderr.includes('SCRCPY_PUSH_FAILED')) {
    return 'Could not push scrcpy-server to the device. The device answered adb but rejected the push — check it is not out of space, and that it is not a locked-down (Play Store) system image.';
  }
  if (stderr.includes('SCRCPY_NO_PORT')) {
    return 'adb could not open a local forward to the device, so the mirror has nowhere to stream from.';
  }
  if (stderr.includes('SCRCPY_NOT_LISTENING')) {
    return 'scrcpy\'s server was launched on the device but never opened its socket. Check /workspace/.android/scrcpy.log in the agent container — a version mismatch between the pinned jar and the server it reports is the usual cause.';
  }
  return `The phone mirror did not start: ${stderr.trim() || 'unknown error'}`;
}

/**
 * Set the device's display rotation, either absolutely (0–3, i.e. 0°/90°/180°/270°) or as a step
 * relative to where it is now — which is what a "rotate left / rotate right" handle wants.
 *
 * `user_rotation` is only honoured while auto-rotate is off, so `accelerometer_rotation` is cleared
 * first; otherwise the sensor immediately overrides whatever we set and the button appears to do
 * nothing. An app that pins its own orientation (most games do) still wins over both — this sets the
 * *device* rotation, not the app's.
 *
 * Echoes `ROTATION:<n>` so the caller can report where it actually landed rather than where it aimed.
 */
export function androidRotateScript(serial: string, opts: { to?: number; step?: number }): string {
  const absolute = typeof opts.to === 'number' ? ((Math.floor(opts.to) % 4) + 4) % 4 : null;
  const step = typeof opts.step === 'number' ? Math.trunc(opts.step) : 1;
  const compute =
    absolute !== null
      ? `next=${absolute}`
      : // `settings get` yields "null" when unset, which is not a number — fall back to 0 rather
        // than letting the arithmetic fail and leaving the device untouched.
        `cur=$(settings get system user_rotation 2>/dev/null | tr -d '\\r\\n'); ` +
        `case "$cur" in ''|*[!0-3]*) cur=0;; esac; ` +
        `next=$(( (cur + ${step} + 4) % 4 ))`;

  return `adb -s ${sq(serial)} shell ${sq(
    `${compute}; settings put system accelerometer_rotation 0; settings put system user_rotation $next; echo "ROTATION:$next"`,
  )}`;
}

/** Planted stream multiplexer (see {@link MIRROR_MUX_SCRIPT}). */
export const MIRROR_MUX_FILE = `${ANDROID_DIR}/mirror_mux.py`;

/**
 * The mirror's stream multiplexer, planted into the agent's container and run over `docker exec`.
 *
 * It replaces the obvious approach — one `socat` per stream — because scrcpy assigns roles by
 * *connection order* (video, then audio, then control) and separate `docker exec` processes race:
 * whichever container process happens to connect first becomes the video stream, so a slow exec
 * silently swaps audio and control and every byte after that is garbage. Upstream scrcpy connects
 * its sockets sequentially from a single process for exactly this reason, and one process here does
 * the same, which makes the ordering correct by construction rather than by timing.
 *
 * Everything is then framed onto one stdio pair as `[u8 stream][u32 BE length][payload]`, in both
 * directions, so the backend gets a single pipe to demultiplex and the control stream has a path
 * back in. Python rather than shell because the android layer already installs it and this needs a
 * real `select` loop.
 */
export const MIRROR_MUX_SCRIPT = `#!/usr/bin/env python3
"""PleiadesAI mirror multiplexer: N ordered scrcpy sockets <-> one framed stdio pair."""
import os
import select
import socket
import struct
import sys

port = int(sys.argv[1])
count = int(sys.argv[2])

# Sequential connects from one process: the listen backlog is FIFO, so connection order is accept
# order, which is what assigns the video / audio / control roles.
socks = []
for _ in range(count):
    s = socket.create_connection(("127.0.0.1", port))
    s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    socks.append(s)

out = sys.stdout.buffer
inp = sys.stdin.buffer
stdin_fd = inp.fileno()
os.set_blocking(stdin_fd, False)

pending = b""


def emit(idx, data):
    out.write(struct.pack(">BI", idx, len(data)))
    out.write(data)
    out.flush()


try:
    while True:
        readable, _, _ = select.select(socks + [stdin_fd], [], [])
        for src in readable:
            if isinstance(src, int):
                chunk = inp.read(65536)
                if chunk is None:
                    continue
                if chunk == b"":
                    raise SystemExit(0)
                pending += chunk
                while len(pending) >= 5:
                    idx, length = struct.unpack(">BI", pending[:5])
                    if len(pending) < 5 + length:
                        break
                    body = pending[5 : 5 + length]
                    pending = pending[5 + length :]
                    if idx < len(socks):
                        socks[idx].sendall(body)
            else:
                data = src.recv(65536)
                if not data:
                    raise SystemExit(0)
                emit(socks.index(src), data)
except (SystemExit, OSError, KeyboardInterrupt, BrokenPipeError):
    pass
finally:
    for s in socks:
        try:
            s.close()
        except OSError:
            pass
`;

/** Audio encoders scrcpy can be asked for. See {@link ScrcpyOptions.audioCodec}. */
export const ANDROID_AUDIO_CODECS = ['aac', 'opus', 'flac'] as const;
export type AndroidAudioCodec = (typeof ANDROID_AUDIO_CODECS)[number];

/** Tuning for the live mirror, taken from the device registry doc. */
export interface ScrcpyOptions {
  /** Longest edge in pixels; 0 keeps the device's native resolution. */
  maxSize: number;
  bitRate: number;
  maxFps: number;
  /** Forward device audio as a third stream. Off unless the operator asked for it. */
  audio: boolean;
  /**
   * Which encoder to ask the device for. **AAC by default, not scrcpy's own default of Opus**:
   * AAC has been a mandatory Android encoder forever, whereas Opus *encoding* is missing on plenty
   * of images — notably redroid, where scrcpy fails with "Could not create default audio encoder
   * for opus" and disables audio in-band. A codec the device lacks costs you the whole audio
   * stream, so the safe option is the default and the better one is opt-in.
   */
  audioCodec: AndroidAudioCodec;
}

/**
 * Idempotent script that starts scrcpy's **server** on the device and opens a local forward to it.
 *
 * How scrcpy works, and why this is only ~30 lines: the "server" is a jar pushed to the device and
 * run through `app_process`. It encodes the screen to H.264 and *listens* on an abstract unix socket
 * on the device (`tunnel_forward=true`); `adb forward` then bridges a TCP port in this container to
 * it. The backend relay opens two connections to that port — the first becomes the **video** socket,
 * the second the **control** socket — and pumps them over the Docker socket, so no port is ever
 * published on any network. See `isolation/scrcpy.ts` for the parsing side.
 *
 * `adb forward tcp:0` asks adb to allocate a free port and print it, which sidesteps port collisions
 * between agents entirely — including under `--network host`, where every agent container shares the
 * host's namespace and a fixed port would clash.
 *
 * The server exits by itself when the client disconnects (`cleanup` defaults on), so there is no stop
 * script to get wrong: closing the relay is what tears the session down.
 *
 * **It must not return until the server is actually listening.** `app_process` takes a second or two
 * to start on the device; connect before that and adb accepts the TCP connection, fails to open the
 * remote stream, and immediately closes it — the relay reads EOF, tears the session down, and the
 * operator gets a blank panel while the device-side log shows a perfectly healthy server waiting for
 * a client that already gave up. So we poll for scrcpy's abstract socket by name, which is
 * observable (`/proc/net/unix` lists it as `@scrcpy_<scid>`) and, unlike connecting to check, does
 * not consume the video socket.
 *
 * Contract (parsed by `ensureAndroidMirror`):
 *  - exit 0 + `SCRCPY_PORT:<n>` on stdout       → server is listening; connect to that port
 *  - exit 3 + `SCRCPY_NO_JAR` on stderr         → image lacks the scrcpy-server jar
 *  - exit 4 + `SCRCPY_PUSH_FAILED` on stderr    → the jar could not be pushed to the device
 *  - exit 5 + `SCRCPY_NO_PORT` on stderr        → `adb forward` did not yield a port
 *  - exit 6 + `SCRCPY_NOT_LISTENING` on stderr  → server launched but never opened its socket
 */
export function scrcpyStartScript(serial: string, scid: string, opts: ScrcpyOptions): string {
  return `#!/usr/bin/env bash
# PleiadesAI scrcpy mirror launch — one session per scid, torn down when the relay disconnects.
set -u

SERIAL=${sq(serial)}
SCID=${sq(scid)}
JAR=${sq(SCRCPY_JAR)}
VERFILE=${sq(SCRCPY_VERSION_FILE)}
LOGDIR=${sq(ANDROID_LOG_DIR)}

mkdir -p "$LOGDIR"

[ -s "$JAR" ] || { echo "SCRCPY_NO_JAR" >&2; exit 3; }
VERSION="$(cat "$VERFILE" 2>/dev/null | tr -d '\\r\\n')"
[ -n "$VERSION" ] || { echo "SCRCPY_NO_JAR" >&2; exit 3; }

# Sweep servers left behind by an abandoned session. scrcpy's server exits when its sockets close,
# but one that no client ever reached is still blocked on accept() and will wait forever, holding a
# socket and a process on the device for every panel that failed to connect. This bounds the fleet to
# one live mirror per device, which matches a single-operator command centre.
# The bracket around the first character matters: pkill -f matches against full command lines, and
# the shell adb spawns to run this very command has the pattern in its own. "[c]om..." still matches
# the server's "com..." but no longer matches the literal text of the pkill command itself, which
# would otherwise make the sweep kill its own shell before ever reaching the real server.
adb -s "$SERIAL" shell 'pkill -f "[c]om.genymobile.scrcpy.Server"' >/dev/null 2>&1 || true

# Pushing every session is not belt-and-braces, it is required: scrcpy's server unlinks its own jar
# once the class is loaded, so /data/local/tmp is empty again by the time the next session starts.
# (It also means a jar bumped in a rebuilt image takes effect with nobody clearing the device copy.)
if ! adb -s "$SERIAL" push "$JAR" ${SCRCPY_DEVICE_JAR} >>"$LOGDIR/scrcpy.log" 2>&1; then
  echo "SCRCPY_PUSH_FAILED" >&2
  exit 4
fi

# tcp:0 → adb picks a free port and prints it. Never a fixed port: under --network host every agent
# container shares the host netns, so a fixed one would collide across agents.
PORT="$(adb -s "$SERIAL" forward tcp:0 localabstract:scrcpy_$SCID 2>>"$LOGDIR/scrcpy.log" | tr -d '\\r\\n')"
case "$PORT" in
  ''|*[!0-9]*) echo "SCRCPY_NO_PORT" >&2; exit 5 ;;
esac

# Detached so it outlives this exec (reparented to PID 1), exactly like the visual stack's daemons.
# The audio flag decides the socket sequence — video,control or video,audio,control — which is why
# the relay is told how many streams to expect rather than guessing.
setsid nohup adb -s "$SERIAL" shell \\
  CLASSPATH=${SCRCPY_DEVICE_JAR} \\
  app_process / com.genymobile.scrcpy.Server "$VERSION" \\
    scid="$SCID" \\
    log_level=info \\
    video=true \\
    audio=${opts.audio ? 'true' : 'false'} \\
    ${opts.audio ? `audio_codec=${opts.audioCodec} \\\n    ` : ''}control=true \\
    tunnel_forward=true \\
    video_codec=h264 \\
    max_size=${Math.max(0, Math.floor(opts.maxSize))} \\
    video_bit_rate=${Math.max(100_000, Math.floor(opts.bitRate))} \\
    max_fps=${Math.max(1, Math.floor(opts.maxFps))} \\
  >>"$LOGDIR/scrcpy.log" 2>&1 </dev/null &

# Wait for the server to open its abstract socket before telling the relay to connect. A server from
# an abandoned session never exits (it blocks forever on accept), so this also gives the stale-server
# sweep above something unambiguous to have cleaned up.
for _ in $(seq 1 100); do
  if adb -s "$SERIAL" shell grep -q "@scrcpy_$SCID" /proc/net/unix 2>/dev/null; then
    echo "SCRCPY_PORT:$PORT"
    exit 0
  fi
  sleep 0.2
done

echo "SCRCPY_NOT_LISTENING" >&2
exit 6
`;
}

/**
 * Remove a finished session's adb forward. The server process exits on its own when the sockets
 * close; the forward would otherwise accumulate one dangling entry per opened panel. Scoped to the
 * one port rather than `--remove-all`, so a second panel opened for the same agent survives.
 */
export function scrcpyCleanupScript(serial: string, port: number): string {
  return `adb -s ${sq(serial)} forward --remove tcp:${Math.floor(port)} >/dev/null 2>&1; true`;
}
