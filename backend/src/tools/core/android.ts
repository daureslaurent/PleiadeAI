/**
 * Android control core tools: `android_ui` (locate), `android_screenshot` (read), `android_act`
 * (drive) and `android_app` (manage apps). The Android counterpart of the `visual_*` desktop tools,
 * with one deliberate difference (see `ANDROID_TOOL_PLAN.md` §1):
 *
 * Android publishes its own view hierarchy — `uiautomator dump` gives every widget's exact pixel
 * bounds, `resource-id`, `text` and `content-desc`. So **locating is structural, not visual**: there
 * is no coordinate grid, no OCR snap and no click calibration here, because there is nothing to
 * guess. The vision model is used only for what it is actually good at — describing/reading a
 * screen (`android_screenshot`).
 *
 * Everything runs *inside* the agent's container via its `AgentExecutor`, and speaks only `adb`, so
 * the device on the other end (a redroid sidecar, a KVM emulator, a physical phone) is swappable
 * without touching these tools. Like the visual tools, they never fall back to the backend — a
 * non-isolated agent gets a clear error, matching the strict isolation guarantee.
 */
import { createLogger } from '../../config/logger';
import type { AgentExecutor } from '../../isolation/AgentContainerManager';
import {
  ANDROID_DEFAULT_SERIAL,
  ANDROID_LOCAL_EMULATOR_SERIAL,
  androidConnectScript,
  androidEmulatorScript,
} from '../../isolation/android.template';
import { settingsService } from '../../domain/settings/settings.service';
import { agentRepository } from '../../domain/agents/agent.repository';
import { isolationRepository } from '../../domain/isolations/isolation.repository';
import { imageRepository } from '../../domain/images/image.repository';
import { resolveForEndpoint } from '../../inference/inference-resolver';
import { annotateIfDegenerate, visionSamplingOpts } from '../../inference/vision-analyze';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import type { ChatMessage } from '../../domain/agents/jit-builder';
import type { Tool, ToolContext } from '../types';

const log = createLogger('tool:android');

const TIMEOUT_MS = 60_000;
/** Screenshots land here inside the container workspace so the operator can also inspect them. */
const SHOT_DIR = '/workspace/.android';
/** Where `uiautomator` writes its dump on the device before we pull it back. */
const DUMP_PATH = '/sdcard/pleiades_window_dump.xml';

const NO_VISION =
  'No Vision endpoint is configured, so this screenshot could not be analysed. Configure one in Settings → Vision endpoint (an endpoint whose model supports vision).';
const GONE_VISION = 'The configured Vision endpoint no longer exists. Pick a valid one in Settings → Vision endpoint.';

// ---------------------------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------------------------

/**
 * Per-agent connect cache. The connect script is idempotent and its happy path is a single `getprop`,
 * but that is still a round-trip through `docker exec` on *every* tool call; a short TTL keeps a
 * multi-step UI interaction snappy while still re-verifying often enough to notice a device that
 * dropped. Cleared implicitly by process lifetime.
 */
const readyUntil = new Map<string, number>();
const READY_TTL_MS = 60_000;

/**
 * How this agent reaches Android: which adb serial to address, and whether an emulator baked into the
 * image has to be launched inside the container first (the all-in-one topology).
 */
interface AndroidTarget {
  serial: string;
  /** AVD to launch in-container before connecting; '' when the device lives elsewhere. */
  avd: string;
}

async function resolveTarget(agentId: string): Promise<AndroidTarget> {
  try {
    const agent = await agentRepository.findById(agentId);
    if (!agent?.isolation_id) return { serial: ANDROID_DEFAULT_SERIAL, avd: '' };
    const iso = await isolationRepository.findById(agent.isolation_id);
    if (!iso?.image_id) return { serial: ANDROID_DEFAULT_SERIAL, avd: '' };
    const image = await imageRepository.findById(iso.image_id);
    const avd = image?.android_emulator_avd?.trim() || '';
    // A locally-launched emulator always lands on `emulator-5554`, so it defines the serial itself;
    // an explicit serial still wins, for the operator running something unusual.
    const fallback = avd ? ANDROID_LOCAL_EMULATOR_SERIAL : ANDROID_DEFAULT_SERIAL;
    return { serial: image?.android_adb_serial?.trim() || fallback, avd };
  } catch {
    return { serial: ANDROID_DEFAULT_SERIAL, avd: '' };
  }
}

/** Cold-booting an in-container emulator is slow even with KVM, so it gets its own budget. */
const EMULATOR_LAUNCH_TIMEOUT_MS = 120_000;

/** Human-readable cause for each failure marker the emulator launch script can emit. */
function emulatorError(stderr: string, avd: string): string {
  if (stderr.includes('ANDROID_NO_EMULATOR')) {
    return 'This agent\'s image has no Android emulator — add the emulator snippet to the image Dockerfile and rebuild, or clear the AVD name to use an external device.';
  }
  const missing = /ANDROID_NO_AVD:(\S+)/.exec(stderr);
  if (missing) return `The image has no AVD named "${missing[1]}". Check the AVD name on the image.`;
  if (stderr.includes('ANDROID_EMU_TIMEOUT')) {
    return `The "${avd}" emulator was launched but never registered with adb.${
      stderr.includes('ANDROID_NO_KVM')
        ? ' /dev/kvm is not available to the container — enable "Hardware acceleration" on the isolation profile (and check the host has nested virtualization).'
        : ' The usual cause is too little CPU/memory on the isolation profile (an emulator needs roughly 4 CPUs and 4g; the defaults are 1 and 1g). See /workspace/.android/emulator.log in the container.'
    }`;
  }
  return `could not launch the "${avd}" emulator: ${stderr.trim() || 'unknown error'}`;
}

/** Human-readable cause for each failure marker the connect script can emit. */
function connectError(stderr: string, serial: string): string {
  if (stderr.includes('ANDROID_NO_ADB')) {
    return 'This agent\'s image has no `adb` — add the Android layer snippet to the image Dockerfile and rebuild.';
  }
  if (stderr.includes('ANDROID_NO_DEVICE')) {
    return `No Android device answered at ${serial}. Check that the device/emulator backend is running and reachable from the agent container.`;
  }
  if (stderr.includes('ANDROID_NOT_BOOTED') || stderr.includes('ANDROID_TIMEOUT')) {
    return `The Android device at ${serial} is reachable but never finished booting (sys.boot_completed never became 1).`;
  }
  return `could not reach the Android device at ${serial}: ${stderr.trim() || 'unknown error'}`;
}

interface AndroidSession {
  exec: AgentExecutor;
  serial: string;
  /** `adb -s <serial>` prefix, ready to splice into a shell command. */
  adb: string;
}

/**
 * Ensure the calling agent has an isolated container *and* a connected, booted Android device, and
 * return the pieces every tool needs. Mirrors `ensureVisual`'s strict contract: a non-isolated agent
 * (or an unready container/device) gets a plain error string, never a backend fallback.
 */
async function ensureAndroid(ctx: ToolContext): Promise<AndroidSession | { error: string }> {
  if (ctx.isolationError) return { error: ctx.isolationError };
  if (!ctx.exec) {
    return {
      error:
        'The android_* tools require an isolated agent. Assign this agent an isolation profile whose image has the Android layer.',
    };
  }
  const exec = ctx.exec;
  const { serial, avd } = await resolveTarget(ctx.agentId);
  const adb = `adb -s ${JSON.stringify(serial)}`;

  // No container boot needed here: `ctx.exec` exists only once AgentRunner has already made the
  // container ready.
  const cached = readyUntil.get(ctx.agentId);
  if (cached && cached > Date.now()) return { exec, serial, adb };

  // All-in-one image: the emulator lives in this container and must be started explicitly, since
  // container creation nulls the image's entrypoint. Idempotent, so calling it here is cheap.
  if (avd) {
    const boot = await exec.run(androidEmulatorScript(avd), { timeoutMs: EMULATOR_LAUNCH_TIMEOUT_MS });
    if (boot.timedOut) return { error: `launching the "${avd}" emulator timed out` };
    if (boot.exitCode !== 0) return { error: emulatorError(boot.stderr, avd) };
    if (boot.stderr.includes('ANDROID_NO_KVM')) {
      log.warn({ agent: ctx.agentName, avd }, 'android emulator running without /dev/kvm — expect it to be very slow');
    }
  }

  const res = await exec.run(androidConnectScript(serial), { timeoutMs: TIMEOUT_MS });
  if (res.timedOut) return { error: `connecting to the Android device at ${serial} timed out` };
  if (res.exitCode !== 0) return { error: connectError(res.stderr, serial) };

  readyUntil.set(ctx.agentId, Date.now() + READY_TTL_MS);
  return { exec, serial, adb };
}

// ---------------------------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------------------------

/**
 * Last screenshot captured per agent, reused as the background for `android_act`'s marker card so the
 * common screenshot→act cycle costs one capture, not two. Display-only and best-effort.
 */
const lastShot = new Map<string, { image: string; width: number; height: number; ts: number }>();
const SHOT_REUSE_MS = 120_000;

interface Capture {
  path?: string;
  /** Full PNG (base64) sent to the vision model. */
  fullB64: string;
  /** Downscaled JPEG (base64) shown in the chat card. */
  thumbB64: string;
  width?: number;
  height?: number;
}

/**
 * Grab the device screen. `adb exec-out` (not `shell`) is essential: it is the only mode that streams
 * raw bytes without the device shell's CRLF translation mangling the PNG.
 */
async function captureScreen(session: AndroidSession): Promise<Capture | { error: string }> {
  const command = [
    'set -e',
    `mkdir -p ${SHOT_DIR}`,
    'ts=$(date +%s%N)',
    `raw="${SHOT_DIR}/shot-$ts.png"`,
    `thumb="${SHOT_DIR}/shot-$ts.thumb.jpg"`,
    `${session.adb} exec-out screencap -p > "$raw"`,
    '[ -s "$raw" ] || { echo "screencap produced no data" >&2; exit 1; }',
    `size=$(python3 - "$raw" "$thumb" <<'PLEIADES_SHOT_PY'`,
    'import sys',
    'from PIL import Image',
    'src, thumb = sys.argv[1], sys.argv[2]',
    "im = Image.open(src).convert('RGB')",
    'w, h = im.size',
    't = im.copy(); t.thumbnail((720, 720)); t.save(thumb, "JPEG", quality=60)',
    "print('%dx%d' % (w, h))",
    'PLEIADES_SHOT_PY',
    ')',
    'echo "ANDROID_PATH:$raw"',
    'echo "ANDROID_SIZE:$size"',
    'echo "ANDROID_FULL:"',
    'base64 -w0 "$raw"',
    'echo',
    'echo "ANDROID_THUMB:"',
    'base64 -w0 "$thumb"',
  ].join('\n');

  const res = await session.exec.run(command, { timeoutMs: TIMEOUT_MS });
  if (res.timedOut || res.exitCode !== 0) {
    return { error: `screenshot failed: ${res.stderr.trim() || res.stdout.trim() || 'device unreachable'}` };
  }
  const out = res.stdout;
  const path = /ANDROID_PATH:(.+)/.exec(out)?.[1]?.trim();
  const sizeMatch = /ANDROID_SIZE:(\d+)x(\d+)/.exec(out);
  const fullMarker = 'ANDROID_FULL:';
  const thumbMarker = 'ANDROID_THUMB:';
  const thumbStart = out.indexOf(thumbMarker);
  const fullB64 = out.slice(out.indexOf(fullMarker) + fullMarker.length, thumbStart).trim();
  const thumbB64 = thumbStart >= 0 ? out.slice(thumbStart + thumbMarker.length).trim() : '';
  if (!fullB64) return { error: 'screenshot produced no image data' };
  return {
    path,
    fullB64,
    thumbB64,
    width: sizeMatch ? Number(sizeMatch[1]) : undefined,
    height: sizeMatch ? Number(sizeMatch[2]) : undefined,
  };
}

/**
 * Best-effort thumbnail used purely as the marker background for `android_act`. Returns null on any
 * failure so the action still runs without a card.
 */
async function markerBackground(session: AndroidSession, agentId: string) {
  const cached = lastShot.get(agentId);
  if (cached && Date.now() - cached.ts <= SHOT_REUSE_MS) return cached;
  const cap = await captureScreen(session);
  if ('error' in cap || !cap.thumbB64 || !cap.width || !cap.height) return null;
  const shot = {
    image: `data:image/jpeg;base64,${cap.thumbB64}`,
    width: cap.width,
    height: cap.height,
    ts: Date.now(),
  };
  lastShot.set(agentId, shot);
  return shot;
}

// ---------------------------------------------------------------------------------------------
// View hierarchy
// ---------------------------------------------------------------------------------------------

/** One widget from the `uiautomator` dump, with its exact pixel rect. */
interface UiNode {
  index: number;
  text: string;
  resource_id: string;
  class: string;
  content_desc: string;
  clickable: boolean;
  enabled: boolean;
  focused: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  center: { x: number; y: number };
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => XML_ENTITIES[m] ?? m);
}

/**
 * Parse a `uiautomator` dump into a flat widget list. Deliberately regex-based rather than pulling in
 * an XML dependency: the input is machine-generated by a single Android component, uses a flat
 * self-closing `<node …>` form with fully escaped attributes, and we only ever read attributes —
 * never structure. A malformed node is skipped rather than failing the whole dump.
 */
function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of (match[1] ?? '').matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[a[1]!] = unescapeXml(a[2]!);
    }
    const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? '');
    if (!bounds) continue;
    const x1 = Number(bounds[1]);
    const y1 = Number(bounds[2]);
    const x2 = Number(bounds[3]);
    const y2 = Number(bounds[4]);
    const width = x2 - x1;
    const height = y2 - y1;
    // Zero-area nodes can't be interacted with and only pad the list the model has to read.
    if (width <= 0 || height <= 0) continue;
    nodes.push({
      index: nodes.length,
      text: attrs.text ?? '',
      resource_id: attrs['resource-id'] ?? '',
      class: attrs.class ?? '',
      content_desc: attrs['content-desc'] ?? '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
      focused: attrs.focused === 'true',
      bounds: { x: x1, y: y1, width, height },
      center: { x: Math.round(x1 + width / 2), y: Math.round(y1 + height / 2) },
    });
  }
  return nodes;
}

/** Dump the current screen's view hierarchy. */
async function dumpUi(session: AndroidSession): Promise<UiNode[] | { error: string }> {
  const command = [
    `${session.adb} shell uiautomator dump ${DUMP_PATH} >/dev/null 2>&1`,
    `${session.adb} exec-out cat ${DUMP_PATH}`,
  ].join('\n');
  const res = await session.exec.run(command, { timeoutMs: TIMEOUT_MS });
  if (res.timedOut) return { error: 'uiautomator dump timed out' };
  const xml = res.stdout;
  if (!xml.includes('<node')) {
    return {
      error: `uiautomator returned no view hierarchy: ${res.stderr.trim() || xml.trim().slice(0, 200) || 'empty dump'}`,
    };
  }
  return parseUiDump(xml);
}

/** A node carries information for the agent if it has a label, an id, or can be acted on. */
function isInformative(n: UiNode): boolean {
  return Boolean(n.text || n.content_desc || n.resource_id || n.clickable);
}

/** Everything a filter/target string is matched against, lowercased. */
function haystack(n: UiNode): string {
  return `${n.text} ${n.content_desc} ${n.resource_id} ${n.class}`.toLowerCase();
}

/**
 * Rank nodes against a target description, best first. An exact label match beats a prefix, which
 * beats a substring anywhere; clickable nodes and smaller nodes win ties — a full-screen container
 * whose text happens to contain the query is almost never what the agent meant.
 */
function rankMatches(nodes: UiNode[], target: string): UiNode[] {
  const q = target.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ n: UiNode; score: number }> = [];
  for (const n of nodes) {
    const label = `${n.text} ${n.content_desc}`.trim().toLowerCase();
    const hay = haystack(n);
    let score = 0;
    if (label === q) score = 100;
    else if (n.resource_id.toLowerCase().endsWith(`/${q}`)) score = 90;
    else if (label.startsWith(q)) score = 70;
    else if (label.includes(q)) score = 50;
    else if (hay.includes(q)) score = 30;
    else continue;
    if (n.clickable) score += 10;
    if (!n.enabled) score -= 20;
    scored.push({ n, score });
  }
  const area = (n: UiNode): number => n.bounds.width * n.bounds.height;
  return scored.sort((a, b) => b.score - a.score || area(a.n) - area(b.n)).map((s) => s.n);
}

/**
 * `android_ui` — the locator. Returns the on-screen widgets with exact pixel bounds, so the agent
 * never has to guess a coordinate from an image.
 */
export const androidUi: Tool = {
  name: 'android_ui',
  description:
    "List the widgets on the Android device's current screen, straight from the system's own view " +
    'hierarchy: each returns its `text`, `resource_id`, `class`, `content_desc`, whether it is ' +
    '`clickable`, its exact pixel `bounds` and its `center`. This is the reliable way to find ' +
    'something on screen — the coordinates are exact, unlike reading them off a screenshot. Pass ' +
    '`filter` to match text / resource-id / content-desc (case-insensitive substring). Use ' +
    'android_screenshot only to *read or describe* a screen; use this to locate anything you intend ' +
    'to tap. (android_act also accepts a `target` description and resolves it through this same dump.)',
  parameters: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'Case-insensitive substring matched against text, content-desc, resource-id and class.',
      },
      clickable_only: {
        type: 'boolean',
        description: 'Only return widgets that can be tapped (default false).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum widgets to return (default 60).',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const ready = await ensureAndroid(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    const dump = await dumpUi(ready);
    if ('error' in dump) return { result: { ok: false, error: dump.error } };

    const filter = String(args.filter ?? '').trim();
    const clickableOnly = args.clickable_only === true;
    const limit = Math.max(1, Math.min(Number(args.limit) || 60, 200));

    let nodes = dump.filter(isInformative);
    if (clickableOnly) nodes = nodes.filter((n) => n.clickable);
    // A filter is a search, so rank by relevance; without one, screen order is the useful order.
    if (filter) nodes = rankMatches(nodes, filter);

    const total = nodes.length;
    log.info({ agent: ctx.agentName, filter: filter || null, total }, 'android ui dump');
    return {
      result: {
        ok: true,
        count: Math.min(total, limit),
        total,
        ...(total > limit ? { truncated: true } : {}),
        elements: nodes.slice(0, limit),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Screenshot (read/describe)
// ---------------------------------------------------------------------------------------------

function contentPrompt(question: string, w: string, h: string): string {
  const ask =
    question.trim() ||
    'Describe what is currently on this Android screen: which app or page it is, and any visible text, controls, or content.';
  return (
    `This is a screenshot of an Android device screen, ${w} pixels wide and ${h} pixels tall.\n\n${ask}\n\n` +
    `Answer in plain text: describe and, where useful, transcribe the visible text accurately. ` +
    `Do NOT output pixel coordinates. Be concise and factual; do not repeat yourself or invent content.`
  );
}

/**
 * `android_screenshot` — capture the device screen and have the configured vision model describe or
 * read it. Describe-mode only, on purpose: locating a widget is `android_ui`'s job and it does it
 * exactly, so none of the desktop's grid / OCR-snap / calibration machinery is needed or wanted here.
 */
export const androidScreenshot: Tool = {
  name: 'android_screenshot',
  description:
    "Look at the Android device's screen: captures a screenshot and a vision model reads or describes " +
    'it. Use this to understand *what* is on screen (read a message, check a state, describe a page). ' +
    'Do NOT use it to find tap coordinates — android_ui returns exact widget bounds and is always ' +
    'more reliable for that. Omit `question` for a general description.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What to read or ask about the screen (e.g. "what does the error message say?").',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const question = String(args.question ?? '');
    const ready = await ensureAndroid(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    const cap = await captureScreen(ready);
    if ('error' in cap) return { result: { ok: false, error: cap.error } };
    const thumbUrl = `data:image/jpeg;base64,${cap.thumbB64 || cap.fullB64}`;
    if (cap.thumbB64 && cap.width && cap.height) {
      lastShot.set(ctx.agentId, { image: thumbUrl, width: cap.width, height: cap.height, ts: Date.now() });
    }

    const settings = await settingsService.get();
    let analysis: string;
    let model = '';
    if (!settings.vision_endpoint_id) {
      analysis = NO_VISION;
    } else {
      const target = await resolveForEndpoint(settings.vision_endpoint_id, settings.vision_model);
      if (!target) {
        analysis = GONE_VISION;
      } else {
        model = target.model;
        const messages: ChatMessage[] = [
          { role: 'system', content: 'You are a helpful assistant that looks at images and answers accurately.' },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${cap.fullB64}` } },
              { type: 'text', text: contentPrompt(question, String(cap.width ?? '?'), String(cap.height ?? '?')) },
            ],
          },
        ];
        try {
          analysis =
            (
              await runWithCaptureContext({ source: 'vision' }, () =>
                llamaClient.complete(target, messages, visionSamplingOpts(settings)),
              )
            ).trim() || '(the vision model returned no text — check the Vision endpoint / mmproj pairing)';
          analysis = annotateIfDegenerate(analysis, model);
        } catch (err) {
          analysis = `vision analysis failed: ${err instanceof Error ? err.message : String(err)}`;
          log.warn({ agent: ctx.agentName, err: String(err) }, 'android vision analysis failed');
        }
      }
    }

    ctx.emitVision?.({ image: thumbUrl, question, answer: analysis, model });
    log.info({ agent: ctx.agentName, path: cap.path, model: model || null }, 'android screenshot analysed');
    return {
      result: {
        ok: true,
        path: cap.path,
        width: cap.width,
        height: cap.height,
        analysis,
        ...(model ? { vision_model: model } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

const ACTIONS = ['tap', 'long_press', 'swipe', 'type', 'key', 'back', 'home', 'recents'] as const;

/** Aliases models reach for that don't quite match the canonical action names. */
const ACTION_ALIASES: Record<string, string> = {
  click: 'tap',
  press: 'tap',
  touch: 'tap',
  longpress: 'long_press',
  longclick: 'long_press',
  longtap: 'long_press',
  scroll: 'swipe',
  drag: 'swipe',
  input: 'type',
  text: 'type',
  keyevent: 'key',
};

function normalizeAction(raw: string): string {
  const s = raw
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
  return ACTION_ALIASES[s.replace(/_/g, '')] ?? s;
}

/**
 * Quote a string for the *device* shell that `adb shell` hands the command to. Single quotes make
 * everything literal (spaces, `&`, `(`, `;`, …), which is what typed text needs — a bare `input text
 * hello world` would otherwise type only "hello".
 */
function deviceQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Canonicalise a key to an Android `KEYCODE_*` name (accepting `back`, `ENTER`, `KEYCODE_TAB`, …). */
function keycode(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return s.startsWith('KEYCODE_') ? s : `KEYCODE_${s}`;
}

/** The fixed navigation keys, so `back`/`home`/`recents` need no keycode knowledge from the model. */
const NAV_KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
};

/**
 * `android_act` — drive the device. Accepts either explicit coordinates or a `target` description
 * resolved through the view hierarchy; the latter is preferred, since it is exact and keeps the
 * agent out of coordinate handling entirely.
 */
export const androidAct: Tool = {
  name: 'android_act',
  description:
    'Drive the Android device: tap, long_press, swipe, type text, press a key, or the back/home/' +
    'recents navigation buttons. **Prefer `target`** — a description or resource-id of the widget to ' +
    'act on (e.g. "Sign in") — which is resolved against the exact view hierarchy; pass `x`/`y` only ' +
    'when you already have exact coordinates from android_ui. For swipe, give `x`/`y` plus `to_x`/' +
    '`to_y` (to scroll a list, swipe from lower on the screen to higher). For type, `text` is typed ' +
    'into the focused field — tap the field first. For key, `text` is a key name like "enter" or "tab".',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do.' },
      target: {
        type: 'string',
        description:
          'Description of the widget to act on (its label, content-desc or resource-id), resolved to exact coordinates via the view hierarchy. Preferred over x/y for tap/long_press.',
      },
      x: { type: 'integer', description: 'Target X in pixels (from android_ui bounds). Ignored when `target` is given.' },
      y: { type: 'integer', description: 'Target Y in pixels.' },
      to_x: { type: 'integer', description: 'Swipe destination X (action=swipe).' },
      to_y: { type: 'integer', description: 'Swipe destination Y (action=swipe).' },
      duration_ms: { type: 'integer', description: 'Swipe/long-press duration in ms (default 300 for swipe, 800 for long_press).' },
      text: { type: 'string', description: 'Text to type (action=type), or the key name (action=key).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const action = normalizeAction(String(args.action ?? ''));
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return { result: { ok: false, error: `unknown action: ${String(args.action ?? '') || '(empty)'}` } };
    }
    const ready = await ensureAndroid(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    let x = Number.isFinite(Number(args.x)) ? Number(args.x) : null;
    let y = Number.isFinite(Number(args.y)) ? Number(args.y) : null;
    let matched: UiNode | null = null;

    // Resolve a described target to exact coordinates. Done before acting so a miss is reported as
    // "not found" (with the candidates on screen) rather than as a tap into empty space.
    const target = String(args.target ?? '').trim();
    if (target && (action === 'tap' || action === 'long_press' || action === 'swipe' || action === 'type')) {
      const dump = await dumpUi(ready);
      if ('error' in dump) return { result: { ok: false, error: dump.error } };
      const matches = rankMatches(dump.filter(isInformative), target);
      if (!matches.length) {
        return {
          result: {
            ok: false,
            error: `no widget on screen matches "${target}"`,
            // Hand back what *is* there, so the next call can pick from reality instead of guessing.
            visible: dump.filter(isInformative).slice(0, 40),
          },
        };
      }
      matched = matches[0]!;
      x = matched.center.x;
      y = matched.center.y;
    }

    const dur = Number(args.duration_ms);
    let shellCmd: string;
    switch (action) {
      case 'tap':
        if (x == null || y == null) return { result: { ok: false, error: 'tap needs `target`, or `x` and `y`' } };
        shellCmd = `input tap ${x} ${y}`;
        break;
      case 'long_press': {
        if (x == null || y == null) return { result: { ok: false, error: 'long_press needs `target`, or `x` and `y`' } };
        // Android has no long-press primitive: a zero-distance swipe held for N ms is the idiom.
        const hold = Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 800;
        shellCmd = `input swipe ${x} ${y} ${x} ${y} ${hold}`;
        break;
      }
      case 'swipe': {
        const tx = Number(args.to_x);
        const ty = Number(args.to_y);
        if (x == null || y == null || !Number.isFinite(tx) || !Number.isFinite(ty)) {
          return { result: { ok: false, error: 'swipe needs x, y, to_x and to_y' } };
        }
        const ms = Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 300;
        shellCmd = `input swipe ${x} ${y} ${Math.round(tx)} ${Math.round(ty)} ${ms}`;
        break;
      }
      case 'type': {
        const text = String(args.text ?? '');
        if (!text) return { result: { ok: false, error: 'type needs `text`' } };
        // Focus the field first when a target was named, so the text can't land in the wrong input.
        const focus = x != null && y != null ? `input tap ${x} ${y}; sleep 0.3; ` : '';
        shellCmd = `${focus}input text ${deviceQuote(text)}`;
        break;
      }
      case 'key': {
        const text = String(args.text ?? '').trim();
        if (!text) return { result: { ok: false, error: 'key needs `text` (a key name such as "enter")' } };
        shellCmd = `input keyevent ${keycode(text)}`;
        break;
      }
      default:
        shellCmd = `input keyevent ${NAV_KEYS[action]}`;
    }

    // Grab the pre-action frame for the marker card before acting, so the card shows the state the
    // agent acted on. Best-effort — a null background just skips the card.
    const bg = await markerBackground(ready, ctx.agentId);

    const res = await ready.exec.run(`${ready.adb} shell ${deviceQuote(shellCmd)}`, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut) return { result: { ok: false, error: `android_act (${action}) timed out` } };
    if (res.exitCode !== 0) {
      return { result: { ok: false, error: `android_act (${action}) failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}` } };
    }

    // The screen has changed, so the cached frame is stale — the next marker card must re-capture.
    lastShot.delete(ctx.agentId);

    if (bg) {
      ctx.emitVisualAct?.({
        image: bg.image,
        width: bg.width,
        height: bg.height,
        action,
        x,
        y,
        x2: action === 'swipe' ? Number(args.to_x) : undefined,
        y2: action === 'swipe' ? Number(args.to_y) : undefined,
        // Reuse the "snapped to" chip to show which widget a described target resolved to.
        snap: matched ? { text: matched.text || matched.content_desc || matched.resource_id, x: matched.center.x, y: matched.center.y } : null,
      });
    }

    log.info({ agent: ctx.agentName, action, x, y, target: target || null }, 'android act');
    return {
      result: {
        ok: true,
        action,
        ...(x != null && y != null ? { at: { x, y } } : {}),
        ...(matched
          ? { matched: { text: matched.text, resource_id: matched.resource_id, content_desc: matched.content_desc, bounds: matched.bounds } }
          : {}),
        ...(res.stdout.trim() ? { output: res.stdout.trim() } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------------------------

const APP_ACTIONS = ['list', 'launch', 'stop', 'install', 'current'] as const;

/**
 * `android_app` — package/activity management: the things a GUI simply cannot do. Installing an APK,
 * launching an app by package name and reading the foreground activity are all far more reliable than
 * hunting for a launcher icon on the home screen.
 */
export const androidApp: Tool = {
  name: 'android_app',
  description:
    'Manage apps on the Android device. action=list lists installed packages (user-installed by ' +
    'default; set `system` true for all). action=launch starts an app by `package` — far more ' +
    'reliable than finding its icon on the home screen. action=stop force-stops it. action=install ' +
    'installs an APK from `path` (a path inside the agent container). action=current reports the ' +
    'app/activity currently in the foreground.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...APP_ACTIONS], description: 'What to do (default list).' },
      package: { type: 'string', description: 'Package name, e.g. com.android.settings (launch/stop).' },
      path: { type: 'string', description: 'APK path inside the agent container (action=install).' },
      filter: { type: 'string', description: 'Substring to filter package names by (action=list).' },
      system: { type: 'boolean', description: 'Include system packages in action=list (default false).' },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const action = String(args.action ?? 'list').trim().toLowerCase();
    if (!APP_ACTIONS.includes(action as (typeof APP_ACTIONS)[number])) {
      return { result: { ok: false, error: `unknown action: ${action || '(empty)'}` } };
    }
    const ready = await ensureAndroid(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };

    const pkg = String(args.package ?? '').trim();
    const needsPkg = action === 'launch' || action === 'stop';
    if (needsPkg && !pkg) return { result: { ok: false, error: `${action} needs \`package\`` } };
    // A package name is [A-Za-z0-9_.]; refusing anything else keeps it out of the device shell line.
    if (pkg && !/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(pkg)) {
      return { result: { ok: false, error: `invalid package name: ${pkg}` } };
    }

    let command: string;
    switch (action) {
      case 'list':
        command = `${ready.adb} shell pm list packages${args.system === true ? '' : ' -3'}`;
        break;
      case 'launch':
        // `monkey … LAUNCHER 1` starts an app knowing only its package — no activity name needed.
        command = `${ready.adb} shell monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
        break;
      case 'stop':
        command = `${ready.adb} shell am force-stop ${pkg}`;
        break;
      case 'install': {
        const path = String(args.path ?? '').trim();
        if (!path) return { result: { ok: false, error: 'install needs `path` (an APK inside the agent container)' } };
        command = `${ready.adb} install -r ${JSON.stringify(path)}`;
        break;
      }
      default:
        // mCurrentFocus covers most versions; mResumedActivity is the newer field — ask for both.
        command = `${ready.adb} shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' || ${ready.adb} shell dumpsys activity activities | grep -E 'mResumedActivity'`;
    }

    const res = await ready.exec.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut) return { result: { ok: false, error: `android_app (${action}) timed out` } };
    const out = res.stdout.trim();
    if (res.exitCode !== 0 && action !== 'current') {
      return { result: { ok: false, error: `android_app (${action}) failed: ${res.stderr.trim() || out || 'no output'}` } };
    }

    if (action === 'list') {
      const filter = String(args.filter ?? '').trim().toLowerCase();
      let packages = out
        .split('\n')
        .map((l) => l.replace(/^package:/, '').trim())
        .filter(Boolean);
      if (filter) packages = packages.filter((p) => p.toLowerCase().includes(filter));
      packages.sort();
      return { result: { ok: true, action, count: packages.length, packages } };
    }

    // launch/stop/install/current: the raw device output is short and is the useful answer.
    log.info({ agent: ctx.agentName, action, package: pkg || null }, 'android app');
    if (action === 'launch' || action === 'stop') lastShot.delete(ctx.agentId);
    return { result: { ok: true, action, ...(pkg ? { package: pkg } : {}), output: out || '(no output)' } };
  },
};
