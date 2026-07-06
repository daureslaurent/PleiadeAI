// Seed the Visual driver skills (`visual_screenshot` + `visual_act`) into a running PleiadeAI.
// These let an agent see and drive its own headless desktop (the Visual skill — see
// VISUAL_SKILL_PLAN.md Phase 4). They run *inside* the agent's isolated container, where Xvfb :99
// and x11vnc are already up, and drive it with pyautogui.
//
// Usage: node scripts/seed-visual-skill.mjs   (targets API_URL, default http://localhost:4000)
// Afterwards: add "visual_screenshot" and "visual_act" to a visual-capable agent's tools_allowed
// (the agent must use an isolation image built with the visual layer snippet).
const API = process.env.API_URL || 'http://localhost:4000';
const USER = process.env.AUTH_USERNAME || 'admin';
const PASS = process.env.AUTH_PASSWORD || 'change-me';

// Common preamble: point at the in-container X display before importing pyautogui (which connects to
// X at import time), and fail *soft* if the visual layer is missing so we never trip the circuit
// breaker for an agent that simply lacks the desktop.
const PREAMBLE = [
  'def _pg():',
  '    import os, sys',
  '    os.environ.setdefault("DISPLAY", ":99")',
  '    os.environ.setdefault("XAUTHORITY", "/opt/pleiade/visual/Xauthority")',
  '    # python-xlib prints an xauthority warning to STDOUT at import; the skill harness parses',
  '    # stdout as JSON, so mute stdout just around the import to keep the protocol clean.',
  '    _real = sys.stdout',
  '    sys.stdout = open(os.devnull, "w")',
  '    try:',
  '        import pyautogui',
  '        pyautogui.FAILSAFE = False',
  '    finally:',
  '        sys.stdout.close()',
  '        sys.stdout = _real',
  '    return pyautogui',
  '',
].join('\n');

const SCREENSHOT_SRC = `${PREAMBLE}
def run(args):
    import os, time, subprocess
    os.environ.setdefault("DISPLAY", ":99")
    os.environ.setdefault("XAUTHORITY", "/opt/pleiade/visual/Xauthority")
    out_dir = "/workspace/.visual"
    try:
        os.makedirs(out_dir, exist_ok=True)
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": "cannot create %s: %s" % (out_dir, exc)}
    path = "%s/shot-%d.png" % (out_dir, int(time.time() * 1000))
    # scrot is reliable on a headless Xvfb; pyscreeze's default backend needs gnome-screenshot.
    r = subprocess.run(["scrot", "-o", path], capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(path):
        return {"success": False, "error": "screenshot failed: %s" % (r.stderr.strip() or "visual desktop unavailable")}
    width = height = None
    try:
        from PIL import Image
        with Image.open(path) as im:
            width, height = im.size
    except Exception:  # noqa: BLE001
        pass
    result = {"success": True, "path": path, "width": width, "height": height}
    if args.get("inline"):
        import base64
        with open(path, "rb") as f:
            result["image_base64"] = base64.b64encode(f.read()).decode("ascii")
    return result
`;

const ACT_SRC = `${PREAMBLE}
def run(args):
    import os
    # A human driving via the noVNC panel holds this lock (written by the backend); don't fight them.
    if os.path.exists("/opt/pleiade/visual/human_control"):
        return {"success": False, "error": "a human has manual control of the desktop; wait and retry"}
    try:
        pg = _pg()
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": "visual desktop unavailable: %s" % exc}
    action = (args.get("action") or "").strip()
    x, y = args.get("x"), args.get("y")
    has_xy = x is not None and y is not None
    pos = (x, y) if has_xy else ()
    try:
        if action == "click":
            pg.click(*pos)
        elif action == "double_click":
            pg.doubleClick(*pos)
        elif action == "right_click":
            pg.rightClick(*pos)
        elif action == "move":
            if not has_xy:
                return {"success": False, "error": "move needs x and y"}
            pg.moveTo(x, y)
        elif action == "drag":
            if has_xy:
                pg.moveTo(x, y)
            tx, ty = args.get("to_x"), args.get("to_y")
            if tx is None or ty is None:
                return {"success": False, "error": "drag needs to_x and to_y"}
            pg.dragTo(tx, ty, duration=0.2)
        elif action == "type":
            pg.typewrite(args.get("text") or "", interval=0.01)
        elif action == "key":
            keys = args.get("keys")
            if isinstance(keys, list) and keys:
                pg.hotkey(*keys)
            elif args.get("text"):
                pg.press(args.get("text"))
            else:
                return {"success": False, "error": "key needs `keys` (list) or `text` (single key)"}
        elif action == "scroll":
            amount = int(args.get("amount") or 0)
            pg.scroll(amount, x=x, y=y) if has_xy else pg.scroll(amount)
        elif action == "size":
            pass
        else:
            return {"success": False, "error": "unknown action: %r" % action}
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": str(exc)}
    w, h = pg.size()
    px, py = pg.position()
    return {"success": True, "action": action, "cursor": [px, py], "screen": [w, h]}
`;

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const post = async (path, body) => {
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`POST ${path} → ${res.status} ${text.slice(0, 160)}`);
  };

  await post('/api/skills', {
    name: 'visual_screenshot',
    description:
      'Capture the agent\'s live desktop. Saves a PNG under /workspace/.visual and returns its path and pixel size. Pass inline=true to also get the image as base64 (large — only for a vision model). Take a screenshot before acting so you can see the screen.',
    language: 'py',
    source: SCREENSHOT_SRC,
    parameters_schema: {
      type: 'object',
      properties: {
        inline: {
          type: 'boolean',
          description: 'Also return the PNG as base64 (image_base64). Large; default false.',
        },
      },
    },
    enabled: true,
  });

  await post('/api/skills', {
    name: 'visual_act',
    description:
      'Drive the agent\'s live desktop: move/click the mouse, type text, press keys, scroll, or drag. Coordinates are screen pixels from the top-left (use visual_screenshot to see the layout first). Returns the cursor position and screen size.',
    language: 'py',
    source: ACT_SRC,
    parameters_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'scroll', 'size'],
          description: 'What to do.',
        },
        x: { type: 'integer', description: 'Target X (pixels). Omit click/right/double to use the current cursor.' },
        y: { type: 'integer', description: 'Target Y (pixels).' },
        to_x: { type: 'integer', description: 'Drag destination X (for action=drag).' },
        to_y: { type: 'integer', description: 'Drag destination Y (for action=drag).' },
        text: { type: 'string', description: 'Text to type (action=type), or a single key name (action=key).' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key combo for action=key, e.g. ["ctrl","c"].',
        },
        amount: { type: 'integer', description: 'Scroll amount for action=scroll (positive up, negative down).' },
      },
      required: ['action'],
    },
    enabled: true,
  });

  console.log('visual skills seeded — add "visual_screenshot" and "visual_act" to a visual agent\'s tools_allowed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
