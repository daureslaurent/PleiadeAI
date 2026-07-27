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

# Fast path: already connected and booted — the common case, so it must stay cheap.
if booted; then echo "ANDROID_ALREADY_UP"; exit 0; fi

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
  if booted; then echo "ANDROID_UP"; exit 0; fi
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
  return `The phone mirror did not start: ${stderr.trim() || 'unknown error'}`;
}

/** Tuning for the live mirror, taken from the device registry doc. */
export interface ScrcpyOptions {
  /** Longest edge in pixels; 0 keeps the device's native resolution. */
  maxSize: number;
  bitRate: number;
  maxFps: number;
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
 * Contract (parsed by `ensureMirror`):
 *  - exit 0 + `SCRCPY_PORT:<n>` on stdout   → server starting, connect to that port
 *  - exit 3 + `SCRCPY_NO_JAR` on stderr     → image lacks the scrcpy-server jar
 *  - exit 4 + `SCRCPY_PUSH_FAILED` on stderr → the jar could not be pushed to the device
 *  - exit 5 + `SCRCPY_NO_PORT` on stderr    → `adb forward` did not yield a port
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

# Pushing is cheap and idempotent; doing it every session means a jar bumped in a rebuilt image takes
# effect without anyone remembering to clear the device's copy.
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
# audio=false keeps the socket sequence to video-then-control, which is what the relay expects.
setsid nohup adb -s "$SERIAL" shell \\
  CLASSPATH=${SCRCPY_DEVICE_JAR} \\
  app_process / com.genymobile.scrcpy.Server "$VERSION" \\
    scid="$SCID" \\
    log_level=info \\
    video=true \\
    audio=false \\
    control=true \\
    tunnel_forward=true \\
    video_codec=h264 \\
    max_size=${Math.max(0, Math.floor(opts.maxSize))} \\
    video_bit_rate=${Math.max(100_000, Math.floor(opts.bitRate))} \\
    max_fps=${Math.max(1, Math.floor(opts.maxFps))} \\
  >>"$LOGDIR/scrcpy.log" 2>&1 </dev/null &

echo "SCRCPY_PORT:$PORT"
exit 0
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
