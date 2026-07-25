/**
 * Android control layer: the agent drives an Android device (emulator, redroid container, or a
 * physical phone) over `adb`, from inside its isolated container. Mirrors `visual.template.ts` — an
 * opt-in Dockerfile snippet, a best-effort lint, and an idempotent connect script planted nowhere:
 * unlike the visual stack there is no daemon to keep alive, so the script is fed to `bash` directly.
 *
 * Deliberately device-agnostic (see `ANDROID_TOOL_PLAN.md` §2): the image installs only the ~few MB
 * `adb` client, never a 10 GB SDK. *Where* Android actually runs — a redroid sidecar container, a
 * KVM-accelerated AVD, or a device on the LAN — is a separate concern that changes nothing here,
 * because every `android_*` tool speaks only adb.
 */

/**
 * Default adb serial the tools talk to. A TCP serial (`host:port`) is `adb connect`-ed on demand;
 * a bare serial (a USB device, or `emulator-5554`) is used as-is. Loopback because the intended
 * topology is the agent container sharing the device container's network namespace, exactly like
 * `network: 'vpn'` shares gluetun's — so nothing is ever bound on a reachable interface.
 */
export const ANDROID_DEFAULT_SERIAL = '127.0.0.1:5555';

/** How long `ensureAndroid` waits for the device to appear *and* finish booting. */
export const ANDROID_BOOT_TIMEOUT_S = 90;

/**
 * Serial a locally-launched emulator gets: the emulator always claims the first free console port
 * pair starting at 5554, and we only ever run one per container.
 */
export const ANDROID_LOCAL_EMULATOR_SERIAL = 'emulator-5554';

/**
 * Dockerfile snippet provisioning the Android layer. Appended by the operator to an "android" image
 * (images are user-authored on the Images page). One `RUN` so it's a single cache layer.
 *
 * `adb` is the whole control surface; `python3-pil` backs the screenshot thumbnails. Deliberately
 * no `scrcpy` — it isn't in Debian bookworm's `main` (the default base image is
 * `node:22-bookworm-slim`), and nothing here needs it: it would only serve a future "mirror the
 * phone onto `:99` so the noVNC panel shows it" feature, which an operator can add themselves.
 */
export const ANDROID_DOCKERFILE_SNIPPET = `# --- PleiadesAI android layer (adb control of an emulator / redroid / physical device) ---
RUN apt-get update && apt-get install -y --no-install-recommends \\
      adb \\
      python3 python3-pil \\
    && rm -rf /var/lib/apt/lists/*`;

/** Runtime binaries the connect script preflights on; a missing one means the image lacks this layer. */
const ANDROID_BINARIES = ['adb'] as const;

/**
 * Best-effort static lint (mirrors `assertVisualLayer`): warn when an image's Dockerfile is unlikely
 * to provide the adb client. Heuristic guidance, not a hard block — the connect script's preflight
 * remains authoritative.
 */
export function assertAndroidLayer(dockerfile: string): string[] {
  const text = dockerfile.toLowerCase();
  const warnings: string[] = [];
  for (const bin of ANDROID_BINARIES) {
    // `adb` is a substring of plenty of unrelated words, so require it as a standalone token.
    if (!new RegExp(`(^|[^a-z0-9_-])${bin}([^a-z0-9_-]|$)`).test(text)) {
      warnings.push(
        `Image Dockerfile does not appear to install "${bin}" — the android_* tools will not work. Add the android layer snippet.`,
      );
    }
  }
  return warnings;
}

/**
 * Shell-quote a value for safe interpolation into the single-quoted context of a generated script.
 * The serial comes from operator config, so it is not hostile — but it is untrusted enough that
 * splicing it raw into a command line would be sloppy.
 */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Dockerfile snippet for an **all-in-one** image: the Android SDK + emulator live in the agent's own
 * container, so no separate device host is needed. Appended *in addition* to the base android layer.
 *
 * Two costs the operator should know about: the built image is ~10 GB (the system image dominates),
 * and the emulator needs `/dev/kvm` — enable "Hardware acceleration" on the isolation profile, and
 * expect a host without nested virtualization to be unusably slow (or to fail `docker create`).
 *
 * `google_apis` rather than `google_apis_playstore`: Play Store images are locked down (no root,
 * no `adb remount`), which breaks a lot of automation for no benefit here.
 *
 * Both interactive tools are fed an *endless* stream of answers (`yes |`, `yes no |`) rather than a
 * single `echo`: a docker build has no TTY, so one line followed by EOF leaves any subsequent prompt
 * blocking forever with nothing to answer it — the build hangs instead of failing.
 */
export const ANDROID_EMULATOR_DOCKERFILE_SNIPPET = `# --- PleiadesAI android emulator (in-container AVD; needs /dev/kvm on the isolation profile) ---
ENV ANDROID_SDK_ROOT=/opt/android-sdk \\
    ANDROID_AVD_HOME=/opt/android-sdk/.avd \\
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator:\${PATH}
ARG ANDROID_API=34
ARG ANDROID_IMAGE=system-images;android-34;google_apis;x86_64
RUN apt-get update && apt-get install -y --no-install-recommends \\
      openjdk-17-jdk-headless unzip curl libpulse0 libgl1 libnss3 libxcursor1 libxi6 \\
    && rm -rf /var/lib/apt/lists/* \\
    && mkdir -p "\${ANDROID_SDK_ROOT}/cmdline-tools" \\
    && curl -fsSL -o /tmp/cmdline.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \\
    && unzip -q /tmp/cmdline.zip -d /tmp/cmdline && rm /tmp/cmdline.zip \\
    && mv /tmp/cmdline/cmdline-tools "\${ANDROID_SDK_ROOT}/cmdline-tools/latest" \\
    && yes | sdkmanager --licenses >/dev/null \\
    && sdkmanager --install "platform-tools" "emulator" "\${ANDROID_IMAGE}" >/dev/null \\
    && yes no | avdmanager create avd -n pleiades -k "\${ANDROID_IMAGE}" --force`;

/**
 * Idempotent launch script for an emulator running **inside** the agent container. Necessary because
 * the container is created with its entrypoint nulled (`docker create --entrypoint '' … tail -f
 * /dev/null`, see `docker.service.createContainer`) — so an image that would normally boot an
 * emulator from its ENTRYPOINT boots into nothing, and we must start it ourselves. Detached with
 * `setsid`/`nohup` so it is reparented to PID 1 and survives the `docker exec` that launches it,
 * exactly like the visual stack's daemons.
 *
 * Only *launches* and waits for the device to be listed; waiting for `sys.boot_completed` is the
 * connect script's job, so the two deadlines stay independent.
 *
 * Contract (parsed by `ensureAndroid`):
 *  - exit 0 + `ANDROID_EMU_ALREADY_UP` / `ANDROID_EMU_UP` → the emulator process is up and listed
 *  - exit 3 + `ANDROID_NO_EMULATOR`                       → image lacks the emulator/SDK layer
 *  - exit 5 + `ANDROID_NO_AVD:<name>`                     → that AVD isn't in the image
 *  - exit 1 + `ANDROID_EMU_TIMEOUT`                       → launched but never appeared to adb
 */
export function androidEmulatorScript(avd: string): string {
  return `#!/usr/bin/env bash
# PleiadesAI android emulator launch — idempotent, detached. Safe to call repeatedly.
set -u

AVD=${sq(avd)}
SERIAL=${sq(ANDROID_LOCAL_EMULATOR_SERIAL)}
LOGDIR=/workspace/.android
mkdir -p "$LOGDIR"

command -v emulator >/dev/null 2>&1 || { echo "ANDROID_NO_EMULATOR" >&2; exit 3; }

# Already running? Judge by the live process, not by a leftover log or socket: a container restart
# preserves the writable layer while killing every process, so a file check would report "up" and
# never revive a dead emulator.
if pgrep -f "qemu-system.*$AVD" >/dev/null 2>&1 || adb devices 2>/dev/null | grep -q "^$SERIAL[[:space:]]"; then
  echo "ANDROID_EMU_ALREADY_UP"
  exit 0
fi

if ! emulator -list-avds 2>/dev/null | grep -qx "$AVD"; then
  echo "ANDROID_NO_AVD:$AVD" >&2
  exit 5
fi

# Without /dev/kvm the emulator falls back to software emulation and is effectively unusable. Say so
# on stderr rather than failing: the operator may knowingly be waiting minutes per frame.
[ -w /dev/kvm ] || echo "ANDROID_NO_KVM" >&2

# -no-window: nothing renders it inside the container, and the tools drive it over adb regardless.
# -no-snapshot: a snapshot saved by an earlier container is usually staler than a cold boot is slow.
setsid nohup emulator -avd "$AVD" \\
  -no-window -no-audio -no-boot-anim -no-snapshot \\
  -gpu swiftshader_indirect \\
  >>"$LOGDIR/emulator.log" 2>&1 </dev/null &

for _ in $(seq 1 60); do
  if adb devices 2>/dev/null | grep -q "^$SERIAL[[:space:]]"; then echo "ANDROID_EMU_UP"; exit 0; fi
  sleep 1
done

echo "ANDROID_EMU_TIMEOUT" >&2
exit 1
`;
}

/**
 * Idempotent connect/readiness script. Starts the adb server, `adb connect`s a TCP serial, then waits
 * for the device to be listed *and* for `sys.boot_completed` — a device that answers adb but is still
 * booting will fail every `input`/`uiautomator` call in a way that looks like a tool bug.
 *
 * Contract (parsed by `ensureAndroid`):
 *  - exit 0 + `ANDROID_ALREADY_UP` / `ANDROID_UP` on stdout → the device is connected and booted
 *  - exit 3 + `ANDROID_NO_ADB` on stderr                    → image lacks the android layer
 *  - exit 4 + `ANDROID_NO_DEVICE` on stderr                 → nothing answered at that serial
 *  - exit 1 + `ANDROID_NOT_BOOTED` / `ANDROID_TIMEOUT`      → reachable but never finished booting
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
# backend is reported as "no device" rather than as a boot timeout.
for _ in $(seq 1 20); do
  if adb devices | grep -q "^$SERIAL[[:space:]]"; then break; fi
  case "$SERIAL" in *:*) adb connect "$SERIAL" >/dev/null 2>&1 || true ;; esac
  sleep 0.5
done
if ! adb devices | grep -q "^$SERIAL[[:space:]]"; then
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
