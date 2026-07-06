/**
 * Visual-control core tools: `visual_screenshot` (see the desktop) and `visual_act` (drive it).
 *
 * These are the built-in replacement for the previously operator-seeded `visual_*` skills — they
 * ship with the app so a visual agent needs no post-init seeding. They only work inside a *visual*
 * isolated container: the agent's isolation profile must reference an Image whose Dockerfile carries
 * the visual layer (Xvfb + x11vnc + xdotool/scrot/pyautogui, see `visual.template.ts`). AgentRunner
 * auto-grants them to such agents.
 *
 * Both tools run *inside* the agent's container via its `AgentExecutor`, booting the desktop stack on
 * demand (`ensureVisual`, idempotent) before acting. Never fall back to the backend — a non-isolated
 * agent gets a clear error, matching the strict isolation guarantee (`bash`/skills do the same).
 */
import { createLogger } from '../../config/logger';
import {
  agentContainerManager,
  IsolationNotReadyError,
  type AgentExecutor,
} from '../../isolation/AgentContainerManager';
import { VISUAL_DIR, VISUAL_DISPLAY } from '../../isolation/visual.template';
import { settingsService } from '../../domain/settings/settings.service';
import { resolveForEndpoint } from '../../inference/inference-resolver';
import { annotateIfDegenerate, visionSamplingOpts } from '../../inference/vision-analyze';
import { llamaClient } from '../../inference/LlamaClient';
import type { ChatMessage } from '../../domain/agents/jit-builder';
import type { Tool, ToolContext } from '../types';

const log = createLogger('tool:visual');

const TIMEOUT_MS = 30_000;
/** Where the driver commands find the X display + a (cookie-less) Xauthority the boot script writes. */
const DISPLAY_ENV = `export DISPLAY=${VISUAL_DISPLAY} XAUTHORITY=${VISUAL_DIR}/Xauthority`;
/** Screenshots land here inside the container workspace so the operator can also inspect them. */
const SHOT_DIR = '/workspace/.visual';

/**
 * Ensure the calling agent has a booted visual desktop and return its executor. Mirrors the strict
 * isolation contract: a non-isolated agent (or an unready container) gets a plain error string, never
 * a backend fallback. Booting is idempotent, so calling this before every action is cheap.
 */
async function ensureVisual(ctx: ToolContext): Promise<{ exec: AgentExecutor } | { error: string }> {
  if (ctx.isolationError) return { error: ctx.isolationError };
  if (!ctx.exec) {
    return {
      error:
        'The visual desktop requires an isolated agent. Assign this agent an isolation profile whose image has the visual layer.',
    };
  }
  try {
    await agentContainerManager.ensureVisual(ctx.agentId);
  } catch (err) {
    if (err instanceof IsolationNotReadyError) return { error: err.message };
    return {
      error: `visual desktop unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { exec: ctx.exec };
}

/**
 * Whether a question is asking to *locate* something (needs pixel coordinates + the grid) vs. to
 * *read/describe* screen content (wants plain text, no coordinates — the grid would just get in the
 * way and bias the model into emitting coordinate tuples instead of the content). English + French.
 */
const LOCALIZE_RE =
  /\b(where|locate|location|position|coordinate|coords?|click|press|button|icon|pixel|x\s*,?\s*y|o[uù]|coordonn|cliqu|bouton|positionn)\b/i;
function isLocalizeQuestion(question: string): boolean {
  return LOCALIZE_RE.test(question);
}

/** Localization prompt: the image carries a coordinate grid; ask for (x, y). */
function localizePrompt(question: string, w: string, h: string): string {
  return (
    `This is a screenshot of a Linux desktop GUI, ${w} pixels wide and ${h} pixels tall. ` +
    `A red reference grid is drawn every 100 pixels: the red numbers along the top/bottom are the x ` +
    `coordinate of each vertical line, and the red numbers down the left/right edges are the y ` +
    `coordinate of each horizontal line. The origin (0,0) is the TOP-LEFT corner; x increases right ` +
    `up to ${w}, y increases downward up to ${h}. Read coordinates OFF THE GRID: find the nearest ` +
    `labelled lines and interpolate between them.\n\n${question.trim()}\n\n` +
    `Answer with the element's centre as pixel coordinates in the form (x, y), with ` +
    `0 ≤ x ≤ ${w} and 0 ≤ y ≤ ${h} — never exceed these bounds. Do not normalise or use 0–1000 values. ` +
    `Answer in at most 3 short lines. Do not repeat yourself.`
  );
}

/** Content prompt: plain-language reading/description — no grid, no coordinates. */
function contentPrompt(question: string, w: string, h: string): string {
  const ask =
    question.trim() ||
    'Describe what is currently on the screen: the active window, and any visible text, controls, or content.';
  return (
    `This is a screenshot of a Linux desktop GUI, ${w} pixels wide and ${h} pixels tall.\n\n${ask}\n\n` +
    `Answer in plain text: describe and, where useful, transcribe the visible text accurately. ` +
    `Do NOT output pixel coordinates. Be concise and factual; do not repeat yourself or invent content.`
  );
}

/**
 * `visual_screenshot` — capture the agent's live desktop, then have the operator-configured **vision
 * model** (Settings → Vision endpoint) analyse it and return a **text answer + coordinates**. The raw
 * pixels go only to the vision model; the calling (text) agent receives the analysis. The screenshot
 * thumbnail + the Q&A are streamed to the chat via `emitVision` so the operator sees them.
 *
 * This is approach A (vision-as-a-tool): the orchestration model stays text-only and drives the GUI
 * fine-grained — screenshot(question) → reason over the analysis → visual_act(coords) → repeat.
 */
export const visualScreenshot: Tool = {
  name: 'visual_screenshot',
  description:
    "Look at the agent's live desktop: captures a screenshot and a vision model answers about it. " +
    'Two modes, chosen from your `question`: ask to READ/DESCRIBE ("what is on screen?", "list the ' +
    'search results", "read the error dialog") to get a plain-text answer; ask to LOCATE ("where is ' +
    'the Submit button?") to get pixel coordinates you can pass to visual_act. Omit `question` for a ' +
    'general description. Take a screenshot before acting. For closing/focusing/finding *windows*, use ' +
    'visual_windows (exact geometry) instead of pixel-hunting the title bar.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'What to look for or ask about the screen (e.g. "where is the address bar?"). Omit for a general description.',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const question = String(args.question ?? '');
    // Locating something needs coordinates + the grid; reading/describing content wants plain text on
    // a *clean* image (the grid occludes text and biases the model into emitting coordinate tuples).
    const localize = isLocalizeQuestion(question);
    const ready = await ensureVisual(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    // Capture, then (only in localize mode) overlay a labelled coordinate grid every 100px. The grid's
    // printed numbers are ground-truth pixels, so the model reads coordinates off them and is immune
    // to any internal resizing. The image sent to the model is also the thumbnail shown in the chat.
    const command = [
      'set -e',
      `mkdir -p ${SHOT_DIR}`,
      'ts=$(date +%s%N)',
      `raw="${SHOT_DIR}/shot-$ts.png"`,
      `out="${SHOT_DIR}/shot-$ts.out.png"`,
      `thumb="${SHOT_DIR}/shot-$ts.thumb.jpg"`,
      `draw="${localize ? '1' : '0'}"`,
      DISPLAY_ENV,
      'scrot -o "$raw"',
      `size=$(python3 - "$raw" "$out" "$thumb" "$draw" <<'PLEIADE_GRID_PY'`,
      'import sys',
      'from PIL import Image, ImageDraw',
      'src, out, thumb, draw = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
      "im = Image.open(src).convert('RGB')",
      'w, h = im.size',
      "if draw == '1':",
      '    d = ImageDraw.Draw(im)',
      '    step = 100',
      '    col = (255, 45, 45)',
      '    for x in range(step, w, step):',
      '        d.line([(x, 0), (x, h)], fill=col, width=1)',
      '        d.text((x + 2, 1), str(x), fill=col)',
      '        d.text((x + 2, h - 11), str(x), fill=col)',
      '    for y in range(step, h, step):',
      '        d.line([(0, y), (w, y)], fill=col, width=1)',
      '        d.text((1, y + 1), str(y), fill=col)',
      '        d.text((w - 34, y + 1), str(y), fill=col)',
      'im.save(out)',
      't = im.copy(); t.thumbnail((720, 720)); t.save(thumb, "JPEG", quality=60)',
      "print('%dx%d' % (w, h))",
      'PLEIADE_GRID_PY',
      ')',
      'echo "VISUAL_PATH:$out"',
      'echo "VISUAL_SIZE:$size"',
      'echo "VISUAL_FULL:"',
      'base64 -w0 "$out"',
      'echo',
      'echo "VISUAL_THUMB:"',
      'base64 -w0 "$thumb"',
    ].join('\n');

    const res = await ctx.exec!.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut || res.exitCode !== 0) {
      return {
        result: {
          ok: false,
          error: `screenshot failed: ${res.stderr.trim() || res.stdout.trim() || 'visual desktop unavailable'}`,
        },
      };
    }

    const out = res.stdout;
    const path = /VISUAL_PATH:(.+)/.exec(out)?.[1]?.trim();
    const sizeMatch = /VISUAL_SIZE:(\d+)x(\d+)/.exec(out);
    const width = sizeMatch ? Number(sizeMatch[1]) : undefined;
    const height = sizeMatch ? Number(sizeMatch[2]) : undefined;
    const fullMarker = 'VISUAL_FULL:';
    const thumbMarker = 'VISUAL_THUMB:';
    const thumbStart = out.indexOf(thumbMarker);
    const fullB64 = out.slice(out.indexOf(fullMarker) + fullMarker.length, thumbStart).trim();
    const thumbB64 = out.slice(thumbStart + thumbMarker.length).trim();
    if (!fullB64) return { result: { ok: false, error: 'screenshot produced no image data' } };
    const thumbUrl = `data:image/jpeg;base64,${thumbB64 || fullB64}`;

    // Analyse the screenshot with the configured vision model. Failures degrade to a helpful message
    // (the tool still succeeds — the agent learns why it can't see and the operator sees the shot).
    const settings = await settingsService.get();
    let analysis: string;
    let model = '';
    if (!settings.vision_endpoint_id) {
      analysis =
        'No Vision endpoint is configured, so this screenshot could not be analysed. Configure one in Settings → Vision endpoint (an endpoint whose model supports vision).';
    } else {
      const target = await resolveForEndpoint(settings.vision_endpoint_id, settings.vision_model);
      if (!target) {
        analysis =
          'The configured Vision endpoint no longer exists. Pick a valid one in Settings → Vision endpoint.';
      } else {
        model = target.model;
        const w = String(width ?? '?');
        const h = String(height ?? '?');
        const prompt = localize ? localizePrompt(question, w, h) : contentPrompt(question, w, h);
        // Image-FIRST, then the text — matches how Qwen2.5-VL et al. are trained (the server places the
        // vision tokens at the image part's position), avoiding "where does the image end" confusion.
        const messages: ChatMessage[] = [
          { role: 'system', content: 'You are a helpful assistant that looks at images and answers accurately.' },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${fullB64}` } },
              { type: 'text', text: prompt },
            ],
          },
        ];
        log.info(
          { url: target.url, model: target.model, imageBytes: Math.round((fullB64.length * 3) / 4) },
          'vision analysis request',
        );
        try {
          // Sampling comes from Settings → Vision (operator-tunable; blank params are omitted so the
          // server uses its own default).
          analysis =
            (await llamaClient.complete(target, messages, visionSamplingOpts(settings))).trim() ||
            '(the vision model returned no text — check the backend logs: llama-client "complete(): model returned little/no usable text")';
          analysis = annotateIfDegenerate(analysis, model);
        } catch (err) {
          analysis = `vision analysis failed: ${err instanceof Error ? err.message : String(err)}`;
          log.warn({ agent: ctx.agentName, err: String(err) }, 'vision analysis call failed');
        }
      }
    }

    // Stream the screenshot + Q&A to the chat (display only — never enters the text agent's context).
    ctx.emitVision?.({ image: thumbUrl, question, answer: analysis, model });

    log.info({ agent: ctx.agentName, path, model: model || null }, 'visual screenshot analysed');
    return {
      result: {
        ok: true,
        path,
        width,
        height,
        // The text the agent reasons on. It never receives the raw pixels (approach A).
        analysis,
        ...(model ? { vision_model: model } : {}),
      },
    };
  },
};

const ACTIONS = [
  'click',
  'double_click',
  'right_click',
  'move',
  'drag',
  'type',
  'key',
  'scroll',
  'size',
] as const;

/** Explicit aliases models tend to use for actions whose canonical name they don't quite match. */
const ACTION_ALIASES: Record<string, string> = {
  dblclick: 'double_click',
  doubleclick: 'double_click',
  doubletap: 'double_click',
  rightclick: 'right_click',
  contextclick: 'right_click',
  leftclick: 'click',
  singleclick: 'click',
  press: 'key',
  hotkey: 'key',
  keypress: 'key',
};

/** Canonicalise an action: split camelCase, unify separators, lowercase, then apply aliases. */
function normalizeAction(raw: string): string {
  const s = raw
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  return ACTION_ALIASES[s.replace(/_/g, '')] ?? s;
}

/** The pyautogui driver run inside the container; args arrive base64-encoded to avoid shell quoting. */
function actScript(b64Args: string): string {
  return [
    'import base64, json, os, subprocess, sys',
    `args = json.loads(base64.b64decode("${b64Args}").decode())`,
    '# A human driving via the noVNC panel holds this lock; do not fight them for input.',
    `if os.path.exists("${VISUAL_DIR}/human_control"):`,
    '    print(json.dumps({"ok": False, "error": "a human has manual control of the desktop; wait and retry"})); sys.exit(0)',
    '# pyautogui connects to X (and python-xlib prints an xauthority warning to stdout) at import;',
    '# mute stdout across the import so our JSON result stays the only thing on stdout.',
    '_real = sys.stdout',
    'sys.stdout = open(os.devnull, "w")',
    'try:',
    '    import pyautogui',
    '    pyautogui.FAILSAFE = False',
    'finally:',
    '    sys.stdout.close(); sys.stdout = _real',
    'action = (args.get("action") or "").strip()',
    'sw, sh = pyautogui.size()',
    '# Clamp coordinates into the screen: the vision model sometimes returns off-screen values',
    '# (e.g. y beyond the height); acting on those would silently fail, so pin them to the edge.',
    'def _clamp(v, hi):',
    '    if v is None: return None, False',
    '    iv = int(v); cv = max(0, min(iv, hi - 1)); return cv, (cv != iv)',
    'x, xc = _clamp(args.get("x"), sw)',
    'y, yc = _clamp(args.get("y"), sh)',
    'tx, txc = _clamp(args.get("to_x"), sw)',
    'ty, tyc = _clamp(args.get("to_y"), sh)',
    'clamped = xc or yc or txc or tyc',
    'has_xy = x is not None and y is not None',
    'pos = (x, y) if has_xy else ()',
    'try:',
    '    if action == "click": pyautogui.click(*pos)',
    '    elif action == "double_click": pyautogui.doubleClick(*pos, interval=0.12)',
    '    elif action == "right_click": pyautogui.rightClick(*pos)',
    '    elif action == "move":',
    '        if not has_xy: raise ValueError("move needs x and y")',
    '        pyautogui.moveTo(x, y)',
    '    elif action == "drag":',
    '        if has_xy: pyautogui.moveTo(x, y)',
    '        if tx is None or ty is None: raise ValueError("drag needs to_x and to_y")',
    '        pyautogui.dragTo(tx, ty, duration=0.2)',
    '    elif action == "type": pyautogui.typewrite(args.get("text") or "", interval=0.01)',
    '    elif action == "key":',
    '        keys = args.get("keys")',
    '        if isinstance(keys, list) and keys: pyautogui.hotkey(*keys)',
    '        elif args.get("text"): pyautogui.press(args.get("text"))',
    '        else: raise ValueError("key needs `keys` (list) or `text` (single key)")',
    '    elif action == "scroll":',
    '        # pyautogui.scroll is a silent no-op on many Xvfb setups; drive the X wheel buttons',
    '        # directly with xdotool (4=up, 5=down, 6=left, 7=right), which reliably scrolls.',
    '        direction = (args.get("direction") or "").strip().lower()',
    '        amount = args.get("amount")',
    '        if not direction:',
    '            # Back-compat: a signed `amount` alone means vertical (positive up, negative down).',
    '            av = int(amount) if amount is not None else 0',
    '            direction = "up" if av >= 0 else "down"',
    '            ticks = abs(av) or 3',
    '        else:',
    '            ticks = abs(int(amount)) if amount is not None else 3',
    '        # Models sometimes pass pixel-sized amounts; each tick is a wheel notch, so cap the burst.',
    '        ticks = max(1, min(ticks, 100))',
    '        button = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction)',
    '        if button is None: raise ValueError("scroll `direction` must be up/down/left/right")',
    '        # Move the pointer over the target pane first so the wheel events land where intended.',
    '        if has_xy: subprocess.run(["xdotool", "mousemove", str(x), str(y)], check=False)',
    '        subprocess.run(["xdotool", "click", "--repeat", str(ticks), str(button)], check=False)',
    '    elif action == "size": pass',
    '    else: raise ValueError("unknown action: %r" % action)',
    'except Exception as exc:',
    '    print(json.dumps({"ok": False, "error": str(exc)})); sys.exit(0)',
    'px, py = pyautogui.position()',
    'res = {"ok": True, "action": action, "cursor": [px, py], "screen": [sw, sh]}',
    'if clamped: res["note"] = "requested coordinates were outside the %dx%d screen and clamped to bounds" % (sw, sh)',
    'print(json.dumps(res))',
  ].join('\n');
}

/**
 * `visual_act` — drive the desktop: move/click, type, press keys, scroll, drag. Coordinates are
 * screen pixels from the top-left (screenshot first to see the layout). Refuses while a human holds
 * manual control via the noVNC panel.
 */
export const visualAct: Tool = {
  name: 'visual_act',
  description:
    "Drive the agent's live desktop: move the mouse, click, double-click (action=double_click), " +
    'right-click, type text, press keys, scroll, or drag. Coordinates are screen pixels from the ' +
    'top-left — use visual_screenshot first to see the layout. For action=scroll, pass x,y over the ' +
    'pane to scroll plus `direction` (up/down/left/right) and `amount` (wheel notches, default 3); ' +
    'the pointer is moved there first so the wheel lands on the right pane. Returns the cursor ' +
    'position and screen size.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      x: { type: 'integer', description: 'Target X (pixels). Omit for click/right/double to use the current cursor.' },
      y: { type: 'integer', description: 'Target Y (pixels).' },
      to_x: { type: 'integer', description: 'Drag destination X (action=drag).' },
      to_y: { type: 'integer', description: 'Drag destination Y (action=drag).' },
      text: { type: 'string', description: 'Text to type (action=type), or a single key name (action=key).' },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Key combo for action=key, e.g. ["ctrl","c"].',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction (action=scroll). Enables horizontal scroll; defaults to vertical from `amount` sign.',
      },
      amount: {
        type: 'integer',
        description:
          'Scroll distance in wheel notches (action=scroll, 1–100, default 3). With no `direction`, a positive value scrolls up and negative scrolls down.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    // Accept the variants a model naturally emits (double-click, doubleClick, dblclick, "double click")
    // and map them to the canonical action before validating — otherwise a valid intent is rejected.
    const action = normalizeAction(String(args.action ?? ''));
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return { result: { ok: false, error: `unknown action: ${String(args.action ?? '') || '(empty)'}` } };
    }
    const ready = await ensureVisual(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    // Send the canonical action to the driver (not the raw variant).
    const b64Args = Buffer.from(JSON.stringify({ ...args, action })).toString('base64');
    // Feed the driver on stdin (via a heredoc) so the base64 blob never needs shell escaping.
    const command = [
      DISPLAY_ENV,
      "python3 - <<'PLEIADE_VISUAL_PY'",
      actScript(b64Args),
      'PLEIADE_VISUAL_PY',
    ].join('\n');

    const res = await ctx.exec!.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut) return { result: { ok: false, error: 'visual_act timed out' } };

    const line = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
      return { result: JSON.parse(line) };
    } catch {
      return {
        result: {
          ok: false,
          error: `visual_act failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}`,
        },
      };
    }
  },
};

/**
 * The xdotool-backed window driver: enumerates and manipulates windows via the window manager, so
 * geometry is exact and actions don't depend on the vision model finding a title-bar button.
 */
function windowsScript(b64Args: string): string {
  return [
    'import base64, json, subprocess, sys',
    `args = json.loads(base64.b64decode("${b64Args}").decode())`,
    'def sh(*a):',
    '    try: return subprocess.run(list(a), capture_output=True, text=True).stdout',
    '    except Exception: return ""',
    'def windows():',
    '    ids = sh("xdotool", "search", "--onlyvisible", "--name", "").split()',
    '    active = sh("xdotool", "getactivewindow").strip()',
    '    seen = set(); out = []',
    '    for wid in ids:',
    '        if wid in seen: continue',
    '        seen.add(wid)',
    '        name = sh("xdotool", "getwindowname", wid).strip()',
    '        geo = {}',
    '        for ln in sh("xdotool", "getwindowgeometry", "--shell", wid).splitlines():',
    '            if "=" in ln: k, v = ln.split("=", 1); geo[k] = v',
    '        try: x, y, w, h = int(geo.get("X",0)), int(geo.get("Y",0)), int(geo.get("WIDTH",0)), int(geo.get("HEIGHT",0))',
    '        except Exception: continue',
    '        if w <= 1 or h <= 1: continue  # skip the root/desktop and zero-size windows',
    '        out.append({"id": wid, "title": name, "x": x, "y": y, "width": w, "height": h, "active": wid == active})',
    '    return out',
    'action = (args.get("action") or "list").strip()',
    'wins = windows()',
    'if action == "list":',
    '    print(json.dumps({"ok": True, "windows": wins})); sys.exit(0)',
    'wid = args.get("id")',
    'if wid is not None:',
    '    target = next((w for w in wins if w["id"] == str(wid)), {"id": str(wid), "title": None})',
    'else:',
    '    t = (args.get("title") or "").lower()',
    '    if not t:',
    '        print(json.dumps({"ok": False, "error": "provide `id` or `title` to target a window", "windows": wins})); sys.exit(0)',
    '    matches = [w for w in wins if t in (w["title"] or "").lower()]',
    '    if not matches:',
    '        print(json.dumps({"ok": False, "error": "no visible window title contains %r" % t, "windows": wins})); sys.exit(0)',
    '    target = matches[0]',
    'cmd = {"close": "windowclose", "activate": "windowactivate", "focus": "windowactivate", "minimize": "windowminimize"}.get(action)',
    'if not cmd:',
    '    print(json.dumps({"ok": False, "error": "unknown action: %r" % action})); sys.exit(0)',
    'r = subprocess.run(["xdotool", cmd, target["id"]], capture_output=True, text=True)',
    'if r.returncode != 0:',
    '    print(json.dumps({"ok": False, "error": r.stderr.strip() or ("xdotool %s failed" % cmd)})); sys.exit(0)',
    'print(json.dumps({"ok": True, "action": action, "id": target["id"], "title": target.get("title")}))',
  ].join('\n');
}

/**
 * `visual_windows` — list and manage desktop windows via the window manager (xdotool). Because it
 * reads exact geometry and acts on windows directly, it's the reliable way to close/focus a window or
 * to get a window's true pixel rect — no vision-model coordinate guessing. See `visual_screenshot` to
 * read on-screen *content*, but prefer this for structural/window operations.
 */
export const visualWindows: Tool = {
  name: 'visual_windows',
  description:
    'List and manage the desktop windows via the window manager — exact geometry, no vision guessing. ' +
    'action=list returns every open window with its id, title, and pixel rect {x,y,width,height}. ' +
    'action=close/activate/minimize targets a window by `id` (from list) or by `title` (case-insensitive ' +
    'substring). Prefer this over clicking a title-bar X to close or switch windows.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'close', 'activate', 'minimize'],
        description: 'What to do (default list).',
      },
      id: { type: 'string', description: 'Window id from a prior list (for close/activate/minimize).' },
      title: {
        type: 'string',
        description: 'Case-insensitive substring of the target window title (alternative to id).',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const ready = await ensureVisual(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    const b64Args = Buffer.from(JSON.stringify(args)).toString('base64');
    const command = [
      DISPLAY_ENV,
      "python3 - <<'PLEIADE_VISUAL_PY'",
      windowsScript(b64Args),
      'PLEIADE_VISUAL_PY',
    ].join('\n');

    const res = await ctx.exec!.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut) return { result: { ok: false, error: 'visual_windows timed out' } };

    const line = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
      return { result: JSON.parse(line) };
    } catch {
      return {
        result: {
          ok: false,
          error: `visual_windows failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}`,
        },
      };
    }
  },
};
