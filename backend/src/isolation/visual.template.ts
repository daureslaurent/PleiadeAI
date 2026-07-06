/**
 * Visual skill: a headless X desktop (Xvfb + a WM) exposed over VNC (x11vnc) and streamed to the
 * browser by the backend. The agent drives the same display locally via the `visual_*` Python skill
 * (xdotool / pyautogui).
 *
 * The stack is **planted and booted on demand** into the agent's existing isolated container (like
 * the skill harnesses and SSH key), never baked into an image entrypoint — the container keeps
 * running `tail -f /dev/null` and every daemon is started detached so it survives the `docker exec`
 * that launches it.
 *
 * Transport (see `VISUAL_SKILL_PLAN.md` §2, decisions Q1/Q2 + the relay refinement): x11vnc serves
 * RFB on a **Unix socket** in the container filesystem — never a TCP port on any network. The backend
 * reaches it by streaming over the Docker socket it already owns — `docker exec -i <container> socat -
 * UNIX-CONNECT:<sock>` — so the relay is network-mode agnostic (host / bridge / vpn) and free of
 * per-agent port collisions even when the container shares the host network namespace.
 */
import { HARNESS_DIR } from './names';

/** X display the desktop runs on (screen `:99`). */
export const VISUAL_DISPLAY = ':99';

/** Directory (under the harness dir) holding the boot script, VNC socket, password, logs, marker. */
export const VISUAL_DIR = `${HARNESS_DIR}/visual`;
/**
 * x11vnc RFB **Unix socket** (not a TCP port). Lives in the container filesystem, so it's per-container
 * even under `--network host`, and nothing is ever bound on any network. The backend relay reaches it
 * with `docker exec … socat - UNIX-CONNECT:<this>`.
 */
export const VISUAL_VNC_SOCK = `${VISUAL_DIR}/vnc.sock`;
/** Planted boot script path. */
export const VISUAL_BOOT_FILE = `${VISUAL_DIR}/boot.sh`;
/** Plaintext VNC password (first line), mode 600, injected at runtime — never in image layers. */
export const VISUAL_PASS_FILE = `${VISUAL_DIR}/vncpass`;
/**
 * Presence of this file means a human has taken manual control via the noVNC panel; the `visual_act`
 * driver skill checks for it and refuses to act, so the agent and operator don't fight over input.
 * The literal path is duplicated in the seeded skill source (a skill can't import this module).
 */
export const VISUAL_CONTROL_LOCK = `${VISUAL_DIR}/human_control`;

/**
 * Dockerfile snippet that provisions the visual layer. Appended by the operator to a "visual" image
 * (images are user-authored in the Images page). Kept as a single `RUN` so it's one cache layer, and
 * only pulled into images that actually need it. `assertVisualLayer` lints for its presence.
 *
 * `socat` is what the backend relay exec's into; `pyautogui`/`pillow` back the Phase 4 driver skill.
 */
export const VISUAL_DOCKERFILE_SNIPPET = `# --- PleiadeAI visual layer (Xvfb desktop + loopback VNC, driven by the visual_* skill) ---
RUN apt-get update && apt-get install -y --no-install-recommends \\
      xvfb x11vnc fluxbox xdotool scrot socat procps \\
      x11-utils x11-xserver-utils fonts-dejavu-core \\
      tesseract-ocr \\
      python3-tk python3-pip \\
    && pip3 install --no-cache-dir --break-system-packages pyautogui pillow \\
    && rm -rf /var/lib/apt/lists/*`;

/** Runtime binaries the boot script preflights on; a missing one means the image lacks this layer. */
const VISUAL_BINARIES = ['Xvfb', 'x11vnc', 'socat'] as const;

/**
 * Best-effort static lint (mirrors `assertRuntimes`): warn when an image's Dockerfile is unlikely to
 * provide the visual stack. Purely heuristic — surfaced as guidance, not a hard block; the boot
 * script's preflight is the authoritative check.
 */
export function assertVisualLayer(dockerfile: string): string[] {
  const text = dockerfile.toLowerCase();
  const warnings: string[] = [];
  for (const bin of VISUAL_BINARIES) {
    if (!text.includes(bin.toLowerCase())) {
      warnings.push(
        `Image Dockerfile does not appear to install "${bin}" — the visual desktop will fail to boot. Add the visual layer snippet.`,
      );
    }
  }
  return warnings;
}

/**
 * The idempotent boot script, planted into the container and run via `bash`. Starts (once) Xvfb, a
 * window manager, and x11vnc serving RFB on a **Unix socket** (no TCP port), password-protected. Each
 * daemon is `setsid`/`nohup`-detached with redirected stdio, so it is reparented to PID1 and outlives
 * the launching `docker exec`. The backend relays the socket over the Docker socket via socat.
 *
 * Contract (parsed by the caller):
 *  - exit 0 + `VISUAL_UP` / `VISUAL_ALREADY_UP` on stdout → x11vnc's RFB socket is present
 *  - exit 3 + `VISUAL_MISSING_BINARIES:<list>` on stderr → image lacks the visual layer
 *  - exit 1 + `VISUAL_TIMEOUT` on stderr → stack did not come up within the deadline
 */
export const VISUAL_BOOT_SCRIPT = `#!/usr/bin/env bash
# PleiadeAI visual stack boot — idempotent, detached daemons. Safe to call repeatedly.
set -u

VDIR=${JSON.stringify(VISUAL_DIR)}
DNUM=${JSON.stringify(VISUAL_DISPLAY)}
SOCK=${JSON.stringify(VISUAL_VNC_SOCK)}
PASSFILE=${JSON.stringify(VISUAL_PASS_FILE)}
GEOMETRY="\${PLEIADE_VISUAL_GEOMETRY:-1280x800x24}"

mkdir -p "$VDIR"

# An empty Xauthority satisfies X client libraries (python-xlib/pyautogui) that insist on reading one;
# local unix-socket connections need no cookie. The driver skill points XAUTHORITY here.
: > "$VDIR/Xauthority" 2>/dev/null || true

# Preflight: a missing binary means the image was built without the visual layer.
missing=""
for bin in Xvfb x11vnc socat; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  echo "VISUAL_MISSING_BINARIES:$missing" >&2
  exit 3
fi

export DISPLAY="$DNUM"

# Readiness is judged by the daemons being ALIVE, not by leftover files. A container restart preserves
# the writable layer (this dir, the "ready" marker, even the x11vnc socket *file*) while killing every
# process — so a file-only check would report "already up" and never revive the dead stack, leaving the
# noVNC relay to connect to a stale socket nothing listens on. Gate on the live x11vnc process (procps
# ships in the visual layer and the rest of this script already relies on pgrep) plus its bound socket.
is_up() {
  [ -S "$SOCK" ] && pgrep -f "x11vnc.*-unixsock $SOCK" >/dev/null 2>&1
}

if is_up; then
  echo "VISUAL_ALREADY_UP"
  exit 0
fi

# Partly (or fully) down — a leftover "ready" marker is now a lie. Drop it so a failure below can't
# leave it behind; it's re-touched only once the stack is genuinely up again.
rm -f "$VDIR/ready"

# Detach a daemon so it survives this exec (reparented to PID1) and log to its own file.
start() { local name="$1"; shift; setsid nohup "$name" "$@" >>"$VDIR/\${name##*/}.log" 2>&1 </dev/null & }

# The X lock + display socket live in /tmp, which also survives a container restart; a stale pair makes
# a fresh Xvfb abort with "server already active for display". Clear them before (re)starting Xvfb.
xnum="\${DNUM#:}"
if ! pgrep -f "Xvfb $DNUM" >/dev/null 2>&1; then
  rm -f "/tmp/.X\${xnum}-lock" "/tmp/.X11-unix/X$xnum" 2>/dev/null || true
  start Xvfb "$DNUM" -screen 0 "$GEOMETRY" -nolisten tcp
fi

# Wait for the X socket before starting anything that needs DISPLAY.
for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X$xnum" ] && break
  sleep 0.1
done

# Start a window manager / desktop session (once) so windows get decorations and xdotool /
# visual_windows can manage them. Prefer a full desktop session (MATE/XFCE), then a bare WM. Override
# with the PLEIADE_VISUAL_WM env var — a full command is allowed (e.g. "mate-session", "marco",
# "startxfce4", or your own launcher). Set it in the image Dockerfile: ENV PLEIADE_VISUAL_WM=marco.
WM_CMD="\${PLEIADE_VISUAL_WM:-}"
if [ -z "$WM_CMD" ]; then
  for cand in mate-session marco xfce4-session openbox fluxbox; do
    if command -v "$cand" >/dev/null 2>&1; then WM_CMD="$cand"; break; fi
  done
fi
# Desktop *session* managers need a D-Bus session bus; wrap them if one isn't already present.
case "$WM_CMD" in
  *session*)
    if [ -z "\${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v dbus-launch >/dev/null 2>&1; then
      WM_CMD="dbus-launch --exit-with-session $WM_CMD"
    fi ;;
esac
WM_PROBE="\${WM_CMD##* }"
if [ -n "$WM_CMD" ] && ! pgrep -f "$WM_PROBE" >/dev/null 2>&1; then
  setsid nohup sh -c "exec $WM_CMD" >>"$VDIR/wm.log" 2>&1 </dev/null &
fi

# Stale socket from a previous run would make x11vnc refuse to bind — clear it if x11vnc is dead.
if ! pgrep -f "x11vnc.*-unixsock $SOCK" >/dev/null 2>&1; then
  rm -f "$SOCK"
  if [ -f "$PASSFILE" ]; then AUTH=(-passwdfile "$PASSFILE"); else AUTH=(-nopw); fi
  start x11vnc -display "$DNUM" -unixsock "$SOCK" -forever -shared -noxdamage "\${AUTH[@]}"
fi

for _ in $(seq 1 100); do
  if is_up; then touch "$VDIR/ready"; echo "VISUAL_UP"; exit 0; fi
  sleep 0.1
done

echo "VISUAL_TIMEOUT" >&2
exit 1
`;
