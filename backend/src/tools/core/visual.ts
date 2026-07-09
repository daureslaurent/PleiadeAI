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
import { agentRepository } from '../../domain/agents/agent.repository';
import { isolationRepository } from '../../domain/isolations/isolation.repository';
import { imageRepository } from '../../domain/images/image.repository';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { resolveForEndpoint } from '../../inference/inference-resolver';
import { annotateIfDegenerate, visionSamplingOpts } from '../../inference/vision-analyze';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import type { ChatMessage } from '../../domain/agents/jit-builder';
import type { Tool, ToolConfigField, ToolContext } from '../types';

const log = createLogger('tool:visual');

const TIMEOUT_MS = 30_000;
/** Where the driver commands find the X display + a (cookie-less) Xauthority the boot script writes. */
const DISPLAY_ENV = `export DISPLAY=${VISUAL_DISPLAY} XAUTHORITY=${VISUAL_DIR}/Xauthority`;

/** Operator-tunable options for the visual tools, surfaced on the Tools page under `visual_screenshot`. */
const VISUAL_CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'capture_delay_ms',
    label: 'Delay before capture (ms)',
    type: 'number',
    default: 500,
    hint: 'Wait this long before grabbing the screen, so menus/animations settle. Applies to all screen captures (visual_screenshot, visual_click, visual_act). 0 = no delay.',
  },
];

/**
 * Bash snippet that pauses right before `scrot`, per the operator-configured capture delay. Shared by
 * every live capture path so the wait is consistent across visual_screenshot / visual_click /
 * visual_act. Returns `[]` (no-op) when the delay is unset or non-positive.
 */
async function captureDelaySnippet(): Promise<string[]> {
  try {
    const { config } = await toolConfigService.resolve('visual_screenshot', VISUAL_CONFIG_SCHEMA);
    const ms = Number(config.capture_delay_ms);
    if (!Number.isFinite(ms) || ms <= 0) return [];
    return [`sleep ${(ms / 1000).toFixed(3)}`];
  } catch {
    return [];
  }
}
/** Screenshots land here inside the container workspace so the operator can also inspect them. */
const SHOT_DIR = '/workspace/.visual';

/**
 * Last clean (grid-free) screenshot captured per agent, so `visual_act` can mark the pixel it acted
 * on over the *same* frame the agent was reasoning about — no extra capture in the common
 * screenshot→act cycle. Reused only while fresh; otherwise `visual_act` grabs a new frame before
 * acting. Cleared implicitly by process lifetime (best-effort, display-only).
 */
const lastShot = new Map<string, { image: string; width: number; height: number; ts: number }>();
/** How long a cached screenshot is considered "the frame the agent is acting on". */
const SHOT_REUSE_MS = 120_000;

function rememberShot(agentId: string, image: string, width?: number, height?: number): void {
  if (!width || !height) return;
  lastShot.set(agentId, { image, width, height, ts: Date.now() });
}

/**
 * Grab a fresh, grid-free screenshot thumbnail from the agent's desktop — the fallback background for
 * `visual_act` when there's no recent `visual_screenshot` to reuse. Best-effort: returns null on any
 * failure so the action itself still proceeds without a marker card.
 */
async function captureCleanThumb(
  exec: AgentExecutor,
): Promise<{ image: string; width: number; height: number } | null> {
  const command = [
    'set -e',
    `mkdir -p ${SHOT_DIR}`,
    'ts=$(date +%s%N)',
    `raw="${SHOT_DIR}/act-$ts.png"`,
    `thumb="${SHOT_DIR}/act-$ts.thumb.jpg"`,
    DISPLAY_ENV,
    ...(await captureDelaySnippet()),
    'scrot -o "$raw"',
    `size=$(python3 - "$raw" "$thumb" <<'PLEIADES_THUMB_PY'`,
    'import sys',
    'from PIL import Image',
    'src, thumb = sys.argv[1], sys.argv[2]',
    "im = Image.open(src).convert('RGB')",
    'w, h = im.size',
    't = im.copy(); t.thumbnail((720, 720)); t.save(thumb, "JPEG", quality=60)',
    "print('%dx%d' % (w, h))",
    'PLEIADES_THUMB_PY',
    ')',
    'echo "VISUAL_SIZE:$size"',
    'echo "VISUAL_THUMB:"',
    'base64 -w0 "$thumb"',
  ].join('\n');
  try {
    const res = await exec.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut || res.exitCode !== 0) return null;
    const out = res.stdout;
    const sizeMatch = /VISUAL_SIZE:(\d+)x(\d+)/.exec(out);
    const marker = 'VISUAL_THUMB:';
    const b64 = out.slice(out.indexOf(marker) + marker.length).trim();
    if (!b64 || !sizeMatch) return null;
    return { image: `data:image/jpeg;base64,${b64}`, width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) };
  } catch {
    return null;
  }
}

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

/**
 * Localization prompt: the image carries a NORMALISED coordinate grid — every crossing is labelled
 * with its (x, y) as fractions of the width/height in the form `x,y` (e.g. `.4,.3`). We ask for
 * fractions in [0,1] with 2 decimals; the tool converts them back to pixels. Small fractional numbers
 * survive the server's image downscale far better than long absolute-pixel labels.
 */
function localizePrompt(question: string): string {
  return (
    `This is a screenshot of a Linux desktop GUI with a red reference grid drawn every 10% of the ` +
    `width and height. Each grid crossing is labelled with its position as fractions of the screen in ` +
    `the form \`x,y\` — e.g. \`.4,.3\` means 40% across (from the LEFT) and 30% down (from the TOP). ` +
    `The origin (0,0) is the TOP-LEFT corner; x goes 0→1 left-to-right, y goes 0→1 top-to-bottom. Read ` +
    `the target's position OFF THE GRID: find the nearest labelled crossings and interpolate between ` +
    `them.\n\n${question.trim()}\n\n` +
    `Answer with the element's centre as fractions in the form (x, y), each between 0 and 1 with 2 ` +
    `decimals — e.g. (0.42, 0.31). Do NOT use pixels or 0–1000 values; use 0–1 fractions only. ` +
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

const NO_VISION =
  'No Vision endpoint is configured, so this screenshot could not be analysed. Configure one in Settings → Vision endpoint (an endpoint whose model supports vision).';
const GONE_VISION = 'The configured Vision endpoint no longer exists. Pick a valid one in Settings → Vision endpoint.';

/**
 * Pull the last (x, y) pair a vision model stated and return it as PIXELS clamped into [0,w)×[0,h).
 * We ask for normalised fractions in [0,1] (e.g. `0.42, 0.31`) and convert them to pixels here. As a
 * safety net for a model that ignores the instruction, values that look like pixels (>1.5) are taken
 * as-is, and mid-range values (≤100, at least one > 1.5) are treated as percentages. The model often
 * restates ("…is at (0.5, 0.64)"), so the *last* pair is its final answer. Null when none is present.
 */
function parseCoords(text: string, w: number, h: number): { x: number; y: number } | null {
  // Capture decimals (incl. leading-dot `.42`) or integers, separated by , ; or x.
  const matches = [...text.matchAll(/(\d*\.?\d+)\s*[,;xX]\s*(\d*\.?\d+)/g)];
  const m = matches[matches.length - 1];
  if (!m) return null;
  const rx = Number(m[1]);
  const ry = Number(m[2]);
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  const toPx = (v: number, dim: number): number => {
    if (v <= 1.5) return v * dim; // normalised fraction (the requested format)
    if (v <= 100) return (v / 100) * dim; // percentage fallback (0–100)
    return v; // already pixels
  };
  const x = toPx(rx, w);
  const y = toPx(ry, h);
  return { x: Math.max(0, Math.min(Math.round(x), w - 1)), y: Math.max(0, Math.min(Math.round(y), h - 1)) };
}

/** One OCR-detected text element with its pixel box (from tesseract TSV output). */
interface OcrBox {
  text: string;
  left: number;
  top: number;
  w: number;
  h: number;
}

/** Words too generic to disambiguate an OCR box from a target description (EN + FR + question words). */
const SNAP_STOPWORDS = new Set([
  'the', 'a', 'an', 'button', 'icon', 'menu', 'field', 'box', 'bar', 'link', 'tab', 'item', 'label',
  'on', 'to', 'of', 'in', 'at', 'click', 'press', 'select', 'open', 'close', 'where', 'is', 'are',
  'find', 'locate', 'show', 'this', 'that', 'there', 'here', 'centre', 'center', 'le', 'la', 'les',
  'un', 'une', 'bouton', 'sur', 'ou', 'où', 'cliquer', 'cliquez',
]);

function snapTokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !SNAP_STOPWORDS.has(t));
}

/** Euclidean distance from a point to a rectangle (0 when inside). */
function distToRect(px: number, py: number, b: OcrBox): number {
  const dx = Math.max(b.left - px, 0, px - (b.left + b.w));
  const dy = Math.max(b.top - py, 0, py - (b.top + b.h));
  return Math.hypot(dx, dy);
}

/**
 * OCR the (clean) screenshot with tesseract and return every text element's pixel box. Best-effort:
 * a missing tesseract (image built before the OCR layer) or any failure yields `[]`, so localization
 * simply falls back to the raw vision coordinate — no hard dependency.
 */
async function ocrBoxes(exec: AgentExecutor, rawPath: string): Promise<OcrBox[]> {
  // --psm 11 = "sparse text": find scattered UI text anywhere. `|| true` so a missing binary is silent.
  const command = `tesseract "${rawPath}" stdout --psm 11 tsv 2>/dev/null || true`;
  try {
    const res = await exec.run(command, { timeoutMs: TIMEOUT_MS });
    const out = res.stdout;
    if (!out.trim()) return [];
    const boxes: OcrBox[] = [];
    for (const line of out.split('\n')) {
      const c = line.split('\t');
      if (c.length < 12 || c[0] === 'level') continue; // skip header + malformed rows
      const conf = Number(c[10]);
      const text = (c[11] ?? '').trim();
      if (!text || !Number.isFinite(conf) || conf < 50) continue;
      const left = Number(c[6]);
      const top = Number(c[7]);
      const w = Number(c[8]);
      const h = Number(c[9]);
      if (![left, top, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
      boxes.push({ text, left, top, w, h });
    }
    return boxes;
  } catch {
    return [];
  }
}

/**
 * Snap a vision-estimated point to the centre of the OCR text box it lands on (or next to), so a
 * text/button/menu click is pixel-exact instead of the model's noisy guess. Only boxes within a small
 * margin of the point are eligible; among those, a box whose text matches the target wins, else the
 * nearest. Returns null (→ keep the vision point) for graphical targets with no nearby text.
 */
function snapToOcr(
  coord: { x: number; y: number },
  boxes: OcrBox[],
  question: string,
  height: number,
): { x: number; y: number; text: string } | null {
  if (!boxes.length) return null;
  const margin = Math.max(24, Math.round(height * 0.03));
  const near = boxes.map((b) => ({ b, d: distToRect(coord.x, coord.y, b) })).filter((o) => o.d <= margin);
  if (!near.length) return null;
  const tokens = snapTokens(question);
  const matches = near.filter((o) => {
    const t = o.b.text.toLowerCase();
    return tokens.some((tok) => t.includes(tok) || tok.includes(t));
  });
  const pool = (matches.length ? matches : near).sort((a, b) => a.d - b.d);
  const b = pool[0]!.b;
  return { x: Math.round(b.left + b.w / 2), y: Math.round(b.top + b.h / 2), text: b.text };
}

type VisionTarget = NonNullable<Awaited<ReturnType<typeof resolveForEndpoint>>>;
type VisionSettings = Awaited<ReturnType<typeof settingsService.get>>;

/** One vision request (image-first, per VL training). Returns the trimmed answer text. */
async function runVision(target: VisionTarget, settings: VisionSettings, b64png: string, prompt: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant that looks at images and answers accurately.' },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64png}` } },
        { type: 'text', text: prompt },
      ],
    },
  ];
  return (
    await runWithCaptureContext({ source: 'vision' }, () =>
      llamaClient.complete(target, messages, visionSamplingOpts(settings)),
    )
  ).trim();
}

interface Capture {
  rawPath?: string;
  /** Full PNG (base64) sent to the vision model — carries the grid in localize mode. */
  fullB64: string;
  /** Downscaled JPEG (base64) shown in the chat card (gridded in localize mode). */
  thumbGridB64: string;
  /** Downscaled grid-free JPEG (base64) — the clean frame reused as the visual_act marker background. */
  thumbCleanB64: string;
  width?: number;
  height?: number;
}

/**
 * Capture the desktop; overlay a labelled coordinate grid when `grid` (localize mode). A `sourcePath`
 * substitutes a pre-rendered PNG for the live screenshot (used by calibration to feed synthetic
 * targets through the exact same localize pipeline) — `scrot` is skipped and that file is the raw.
 */
async function captureScreen(exec: AgentExecutor, grid: boolean, sourcePath?: string): Promise<Capture | { error: string }> {
  const command = [
    'set -e',
    `mkdir -p ${SHOT_DIR}`,
    'ts=$(date +%s%N)',
    sourcePath ? `raw="${sourcePath}"` : `raw="${SHOT_DIR}/shot-$ts.png"`,
    `out="${SHOT_DIR}/shot-$ts.out.png"`,
    `thumb="${SHOT_DIR}/shot-$ts.thumb.jpg"`,
    `cthumb="${SHOT_DIR}/shot-$ts.clean.jpg"`,
    `draw="${grid ? '1' : '0'}"`,
    DISPLAY_ENV,
    ...(sourcePath ? [] : [...(await captureDelaySnippet()), 'scrot -o "$raw"']),
    `size=$(python3 - "$raw" "$out" "$thumb" "$draw" "$cthumb" <<'PLEIADES_GRID_PY'`,
    'import sys',
    'from PIL import Image, ImageDraw',
    'src, out, thumb, draw, cthumb = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]',
    "im = Image.open(src).convert('RGB')",
    'w, h = im.size',
    '# Clean (grid-free) thumbnail captured before any grid overlay — reused as the visual_act background.',
    'ct = im.copy(); ct.thumbnail((720, 720)); ct.save(cthumb, "JPEG", quality=60)',
    "if draw == '1':",
    '    d = ImageDraw.Draw(im)',
    '    col = (255, 45, 45)',
    '    # NORMALISED grid: a line every 10% of width/height, and at every crossing the (x,y) position',
    '    # as fractions like ".4,.3" — short labels that survive the vision server\'s image downscale.',
    '    def frac(i):  # ".1".."9" (drop the leading zero to keep labels tiny)',
    "        return ('%.1f' % (i / 10.0)).lstrip('0') or '0'",
    '    for i in range(1, 10):',
    '        x = round(w * i / 10.0); y = round(h * i / 10.0)',
    '        d.line([(x, 0), (x, h)], fill=col, width=1)',
    '        d.line([(0, y), (w, y)], fill=col, width=1)',
    '    for i in range(1, 10):',
    '        for j in range(1, 10):',
    '            x = round(w * i / 10.0); y = round(h * j / 10.0)',
    "            d.text((x + 2, y + 1), frac(i) + ',' + frac(j), fill=col)",
    'im.save(out)',
    't = im.copy(); t.thumbnail((720, 720)); t.save(thumb, "JPEG", quality=60)',
    "print('%dx%d' % (w, h))",
    'PLEIADES_GRID_PY',
    ')',
    'echo "VISUAL_PATH:$raw"',
    'echo "VISUAL_SIZE:$size"',
    'echo "VISUAL_FULL:"',
    'base64 -w0 "$out"',
    'echo',
    'echo "VISUAL_THUMB:"',
    'base64 -w0 "$thumb"',
    'echo',
    'echo "VISUAL_CLEAN:"',
    'base64 -w0 "$cthumb"',
  ].join('\n');

  const res = await exec.run(command, { timeoutMs: TIMEOUT_MS });
  if (res.timedOut || res.exitCode !== 0) {
    return { error: `screenshot failed: ${res.stderr.trim() || res.stdout.trim() || 'visual desktop unavailable'}` };
  }
  const out = res.stdout;
  const rawPath = /VISUAL_PATH:(.+)/.exec(out)?.[1]?.trim();
  const sizeMatch = /VISUAL_SIZE:(\d+)x(\d+)/.exec(out);
  const width = sizeMatch ? Number(sizeMatch[1]) : undefined;
  const height = sizeMatch ? Number(sizeMatch[2]) : undefined;
  const fullMarker = 'VISUAL_FULL:';
  const thumbMarker = 'VISUAL_THUMB:';
  const cleanMarker = 'VISUAL_CLEAN:';
  const thumbStart = out.indexOf(thumbMarker);
  const cleanStart = out.indexOf(cleanMarker);
  const fullB64 = out.slice(out.indexOf(fullMarker) + fullMarker.length, thumbStart).trim();
  const thumbGridB64 = out.slice(thumbStart + thumbMarker.length, cleanStart).trim();
  const thumbCleanB64 = cleanStart >= 0 ? out.slice(cleanStart + cleanMarker.length).trim() : '';
  if (!fullB64) return { error: 'screenshot produced no image data' };
  return { rawPath, fullB64, thumbGridB64, thumbCleanB64, width, height };
}

interface Located {
  x: number | null;
  y: number | null;
  /** The vision model's text (plus any OCR-snap note) — display + agent reasoning. */
  analysis: string;
  model: string;
  /** Set when the vision point was snapped to an OCR text box — drives the "OCR" chip in chat. */
  snap?: { text: string; x: number; y: number } | null;
  /** Gridded thumbnail (data URL) for the chat vision card. */
  thumbGrid: string;
  /** Clean thumbnail (data URL) reused as the visual_act marker background. */
  thumbClean: string;
  width: number;
  height: number;
}

/**
 * Locate a described target on the desktop and return its pixel coordinate: the vision model reads
 * (x, y) off the gridded screenshot, then — for a *text* target — the point is snapped to the exact
 * centre of the OCR-detected text box it lands on (pixel-perfect for buttons/menus/labels); graphical
 * targets keep the vision point (+ calibration). Shared by `visual_screenshot` (localize) and
 * `visual_click`.
 */
async function locate(
  ctx: ToolContext,
  exec: AgentExecutor,
  question: string,
  opts?: { sourcePath?: string; applyCalibration?: boolean },
): Promise<Located | { error: string }> {
  const cap = await captureScreen(exec, true, opts?.sourcePath);
  if ('error' in cap) return { error: cap.error };
  const width = cap.width ?? 0;
  const height = cap.height ?? 0;
  const thumbClean = `data:image/jpeg;base64,${cap.thumbCleanB64 || cap.thumbGridB64 || cap.fullB64}`;
  // Don't pollute the visual_act marker cache with a synthetic calibration frame.
  if (!opts?.sourcePath && cap.thumbCleanB64) rememberShot(ctx.agentId, thumbClean, width, height);
  const thumbGrid = `data:image/jpeg;base64,${cap.thumbGridB64 || cap.fullB64}`;

  const settings = await settingsService.get();
  const base = { model: '', thumbGrid, thumbClean, width, height };
  if (!settings.vision_endpoint_id) return { x: null, y: null, analysis: NO_VISION, ...base };
  const target = await resolveForEndpoint(settings.vision_endpoint_id, settings.vision_model);
  if (!target) return { x: null, y: null, analysis: GONE_VISION, ...base };
  const model = target.model;

  let analysis: string;
  let coord: { x: number; y: number } | null;
  try {
    const raw = await runVision(target, settings, cap.fullB64, localizePrompt(question));
    analysis = raw || '(the vision model returned no text — check the Vision endpoint / mmproj pairing)';
    coord = parseCoords(raw, width, height);
  } catch (err) {
    log.warn({ agent: ctx.agentName, err: String(err) }, 'vision localize call failed');
    return { x: null, y: null, analysis: `vision analysis failed: ${err instanceof Error ? err.message : String(err)}`, ...base, thumbGrid, model };
  }

  // OCR snap: the vision model's absolute coordinate is imprecise, so for a *text* target snap the
  // point to the exact centre of the OCR-detected text box it lands on/near — pixel-perfect for
  // buttons/menus/labels. A snapped box is already exact, so we skip calibration for it. Graphical
  // targets (no nearby text) fall through to the raw vision point + calibration. Skipped for the
  // synthetic calibration frames (no text, and we must not perturb the measurement).
  let snapped = false;
  let snap: { text: string; x: number; y: number } | null = null;
  if (coord && !opts?.sourcePath && cap.rawPath) {
    const boxes = await ocrBoxes(exec, cap.rawPath);
    const hit = snapToOcr(coord, boxes, question, height);
    if (hit) {
      log.info({ agent: ctx.agentName, from: coord, to: { x: hit.x, y: hit.y }, text: hit.text }, 'snapped to OCR text box');
      analysis = `${analysis}\n→ snapped to text "${hit.text}" at (${hit.x}, ${hit.y})`;
      coord = { x: hit.x, y: hit.y };
      snapped = true;
      snap = hit;
    }
  }

  // Apply the image's click calibration (unless measuring it, or we already snapped to an exact OCR
  // box): correct the vision model's small, consistent coordinate bias so the click lands on target.
  // No-op when uncalibrated / model mismatch.
  if (coord && !snapped && (opts?.applyCalibration ?? true) && model) {
    const cal = await loadCalibration(ctx.agentId, model, width, height);
    if (cal) {
      const cx = Math.max(0, Math.min(Math.round(cal.ax * coord.x + cal.bx), width - 1));
      const cy = Math.max(0, Math.min(Math.round(cal.ay * coord.y + cal.by), height - 1));
      log.info({ agent: ctx.agentName, from: coord, to: { x: cx, y: cy } }, 'applied click calibration');
      coord = { x: cx, y: cy };
    }
  }

  return { x: coord?.x ?? null, y: coord?.y ?? null, analysis, model, thumbGrid, thumbClean, width, height, snap };
}

/** The affine correction stored on an image, if it matches the current vision model + resolution. */
async function loadCalibration(
  agentId: string,
  visionModel: string,
  width: number,
  height: number,
): Promise<{ ax: number; bx: number; ay: number; by: number } | null> {
  try {
    const agent = await agentRepository.findById(agentId);
    if (!agent?.isolation_id) return null;
    const iso = await isolationRepository.findById(agent.isolation_id);
    if (!iso?.image_id) return null;
    const image = await imageRepository.findById(iso.image_id);
    const cal = image?.visual_calibration;
    if (!cal || cal.vision_model !== visionModel) return null;
    // A resolution change invalidates the fit (the desktop geometry changed).
    if (cal.width && cal.height && (cal.width !== width || cal.height !== height)) return null;
    return { ax: cal.ax, bx: cal.bx, ay: cal.ay, by: cal.by };
  } catch {
    return null;
  }
}

/** Least-squares fit of `t = a·r + b` over [reported, true] pairs, with mean abs error before/after. */
function fitAxis(pairs: Array<[number, number]>): { a: number; b: number; before: number; after: number } {
  const n = pairs.length;
  let sr = 0;
  let st = 0;
  let srr = 0;
  let srt = 0;
  for (const [r, t] of pairs) {
    sr += r;
    st += t;
    srr += r * r;
    srt += r * t;
  }
  const denom = n * srr - sr * sr;
  // Degenerate spread (all reported values equal) → pure offset, slope 1.
  let a = 1;
  let b = (st - sr) / n;
  if (Math.abs(denom) > 1e-6) {
    a = (n * srt - sr * st) / denom;
    b = (st - a * sr) / n;
  }
  let before = 0;
  let after = 0;
  for (const [r, t] of pairs) {
    before += Math.abs(r - t);
    after += Math.abs(a * r + b - t);
  }
  return { a, b, before: before / n, after: after / n };
}

/** Render a synthetic calibration target (a solid blue dot + white crosshair) at a known pixel. */
async function renderCalibTarget(exec: AgentExecutor, x: number, y: number, W: number, H: number): Promise<string | null> {
  const out = `${SHOT_DIR}/calib-target.png`;
  const command = [
    'set -e',
    `mkdir -p ${SHOT_DIR}`,
    `python3 - ${W} ${H} ${x} ${y} "${out}" <<'PLEIADES_CALIB_PY'`,
    'import sys',
    'from PIL import Image, ImageDraw',
    'W, H, x, y, out = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]',
    "im = Image.new('RGB', (W, H), (60, 60, 66))",
    'd = ImageDraw.Draw(im); r = 14',
    'd.ellipse([x - r, y - r, x + r, y + r], fill=(30, 110, 240))',
    'd.line([(x - r * 2, y), (x + r * 2, y)], fill=(255, 255, 255), width=1)',
    'd.line([(x, y - r * 2), (x, y + r * 2)], fill=(255, 255, 255), width=1)',
    'im.save(out)',
    'PLEIADES_CALIB_PY',
  ].join('\n');
  try {
    const res = await exec.run(command, { timeoutMs: TIMEOUT_MS });
    return res.timedOut || res.exitCode !== 0 ? null : out;
  } catch {
    return null;
  }
}

export interface CalibrationResult {
  vision_model: string;
  width: number;
  height: number;
  ax: number;
  bx: number;
  ay: number;
  by: number;
  samples: number;
  error_before: number;
  error_after: number;
}

/**
 * Measure this desktop's click calibration: render synthetic targets at known pixels, run each
 * through the *same* localize pipeline (calibration + OCR-snap off), and fit a per-axis
 * affine that maps the model's reported coordinate back to the true one. Returns the fit (the caller
 * persists it on the image) or an error string. Feeds synthetic frames — it never touches or captures
 * the real desktop content, so it's safe to run while the agent is idle.
 */
export async function measureVisualCalibration(
  exec: AgentExecutor,
  agentName: string,
): Promise<CalibrationResult | { error: string }> {
  const settings = await settingsService.get();
  if (!settings.vision_endpoint_id) return { error: 'No Vision endpoint is configured (Settings → Vision endpoint).' };
  const target = await resolveForEndpoint(settings.vision_endpoint_id, settings.vision_model);
  if (!target) return { error: 'The configured Vision endpoint no longer exists.' };

  // Learn the desktop resolution from a throwaway clean capture.
  const cap0 = await captureScreen(exec, false);
  if ('error' in cap0) return { error: cap0.error };
  const width = cap0.width ?? 0;
  const height = cap0.height ?? 0;
  if (!width || !height) return { error: 'could not determine the desktop resolution' };

  // A spread lattice (quincunx-ish) so the per-axis fit has ≥2 distinct coordinates on each axis.
  const fx = [0.22, 0.5, 0.78];
  const fy = [0.25, 0.5, 0.75];
  const points = [
    { x: fx[0]!, y: fy[0]! },
    { x: fx[2]!, y: fy[0]! },
    { x: fx[1]!, y: fy[1]! },
    { x: fx[0]!, y: fy[2]! },
    { x: fx[2]!, y: fy[2]! },
  ].map((p) => ({ x: Math.round(p.x * width), y: Math.round(p.y * height) }));

  const ctx = { agentId: 'calibration', agentName, depth: 0, sessionId: 'calibration' } as unknown as ToolContext;
  const xs: Array<[number, number]> = [];
  const ys: Array<[number, number]> = [];
  for (const p of points) {
    const path = await renderCalibTarget(exec, p.x, p.y, width, height);
    if (!path) continue;
    const loc = await locate(ctx, exec, 'the centre of the solid blue dot', { sourcePath: path, applyCalibration: false });
    if ('error' in loc || loc.x == null || loc.y == null) continue;
    xs.push([loc.x, p.x]);
    ys.push([loc.y, p.y]);
  }
  if (xs.length < 3) {
    return { error: `calibration failed: only ${xs.length} of ${points.length} targets were located — check the Vision endpoint` };
  }

  const rx = fitAxis(xs);
  const ry = fitAxis(ys);
  return {
    vision_model: target.model,
    width,
    height,
    ax: rx.a,
    bx: rx.b,
    ay: ry.a,
    by: ry.b,
    samples: xs.length,
    error_before: (rx.before + ry.before) / 2,
    error_after: (rx.after + ry.after) / 2,
  };
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
    'the Submit button?") to get precise pixel coordinates (also returned as structured `x`/`y`) you ' +
    'can pass to visual_act. To *click* a described element, prefer visual_click (it locates + clicks ' +
    'in one step, more accurately). Omit `question` for a general description. For closing/focusing/' +
    'finding *windows*, use visual_windows (exact geometry) instead of pixel-hunting the title bar.',
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
  configSchema: VISUAL_CONFIG_SCHEMA,

  async execute(args, ctx) {
    const question = String(args.question ?? '');
    // Locating something needs coordinates + the grid; reading/describing content wants plain text on
    // a *clean* image (the grid occludes text and biases the model into emitting coordinate tuples).
    const localize = isLocalizeQuestion(question);
    const ready = await ensureVisual(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };
    const exec = ready.exec;

    // Localize mode: vision locate (+ OCR snap) → structured x/y. No degenerate-warning here (a short
    // numeric answer like "(500, 640)" is exactly what we asked for, not a misconfigured endpoint).
    if (localize) {
      const loc = await locate(ctx, exec, question);
      if ('error' in loc) return { result: { ok: false, error: loc.error } };
      // Mark the located pixel on the gridded preview in chat, so the operator can cross-check the
      // point against the same coordinate grid the vision model read.
      ctx.emitVision?.({
        image: loc.thumbGrid,
        question,
        answer: loc.analysis,
        model: loc.model,
        x: loc.x,
        y: loc.y,
        width: loc.width,
        height: loc.height,
        snap: loc.snap,
      });
      log.info({ agent: ctx.agentName, model: loc.model || null, x: loc.x, y: loc.y }, 'visual screenshot localized');
      return {
        result: {
          ok: true,
          width: loc.width,
          height: loc.height,
          x: loc.x,
          y: loc.y,
          analysis: loc.analysis,
          ...(loc.model ? { vision_model: loc.model } : {}),
        },
      };
    }

    // Describe/read mode: clean capture, plain-text content answer.
    const cap = await captureScreen(exec, false);
    if ('error' in cap) return { result: { ok: false, error: cap.error } };
    const width = cap.width;
    const height = cap.height;
    const thumbUrl = `data:image/jpeg;base64,${cap.thumbCleanB64 || cap.thumbGridB64 || cap.fullB64}`;
    if (cap.thumbCleanB64) rememberShot(ctx.agentId, thumbUrl, width, height);

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
        const prompt = contentPrompt(question, String(width ?? '?'), String(height ?? '?'));
        log.info(
          { url: target.url, model: target.model, imageBytes: Math.round((cap.fullB64.length * 3) / 4) },
          'vision analysis request',
        );
        try {
          analysis =
            (await runVision(target, settings, cap.fullB64, prompt)) ||
            '(the vision model returned no text — check the backend logs: llama-client "complete(): model returned little/no usable text")';
          analysis = annotateIfDegenerate(analysis, model);
        } catch (err) {
          analysis = `vision analysis failed: ${err instanceof Error ? err.message : String(err)}`;
          log.warn({ agent: ctx.agentName, err: String(err) }, 'vision analysis call failed');
        }
      }
    }

    ctx.emitVision?.({ image: thumbUrl, question, answer: analysis, model });
    log.info({ agent: ctx.agentName, path: cap.rawPath, model: model || null }, 'visual screenshot analysed');
    return {
      result: {
        ok: true,
        path: cap.rawPath,
        width,
        height,
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
    const exec = ready.exec;

    // Pick the frame to mark the action on: reuse the recent screenshot the agent was reasoning over
    // (no extra capture in the usual screenshot→act cycle), else grab a fresh grid-free frame *before*
    // acting so the marker sits on the pre-action state. Best-effort — a null background just skips the
    // marker card, the action still runs.
    const cached = lastShot.get(ctx.agentId);
    const bg =
      cached && Date.now() - cached.ts <= SHOT_REUSE_MS
        ? { image: cached.image, width: cached.width, height: cached.height }
        : await captureCleanThumb(exec);

    // Send the canonical action to the driver (not the raw variant).
    const b64Args = Buffer.from(JSON.stringify({ ...args, action })).toString('base64');
    // Feed the driver on stdin (via a heredoc) so the base64 blob never needs shell escaping.
    const command = [
      DISPLAY_ENV,
      "python3 - <<'PLEIADES_VISUAL_PY'",
      actScript(b64Args),
      'PLEIADES_VISUAL_PY',
    ].join('\n');

    const res = await exec.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut) return { result: { ok: false, error: 'visual_act timed out' } };

    const line = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {
        result: {
          ok: false,
          error: `visual_act failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}`,
        },
      };
    }

    // Stream an action-marker card + a live-desktop pulse: mark where the action landed over `bg`.
    if (bg) {
      const screen = Array.isArray(parsed.screen) ? (parsed.screen as number[]) : null;
      const cursor = Array.isArray(parsed.cursor) ? (parsed.cursor as number[]) : null;
      const w = screen?.[0] ?? bg.width;
      const h = screen?.[1] ?? bg.height;
      const clamp = (v: unknown, hi: number): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(Math.round(v), hi - 1)) : null;
      // Primary point: for a drag it's the start (with the end as x2/y2); for everything else the final
      // cursor position, which is where the click/move/scroll landed (and where typed input went).
      let x: number | null;
      let y: number | null;
      let x2: number | null | undefined;
      let y2: number | null | undefined;
      if (action === 'drag') {
        x = clamp(args.x, w) ?? (cursor ? clamp(cursor[0], w) : null);
        y = clamp(args.y, h) ?? (cursor ? clamp(cursor[1], h) : null);
        x2 = clamp(args.to_x, w) ?? (cursor ? clamp(cursor[0], w) : null);
        y2 = clamp(args.to_y, h) ?? (cursor ? clamp(cursor[1], h) : null);
      } else {
        x = cursor ? clamp(cursor[0], w) : clamp(args.x, w);
        y = cursor ? clamp(cursor[1], h) : clamp(args.y, h);
      }
      ctx.emitVisualAct?.({ image: bg.image, width: w, height: h, action, x, y, x2, y2 });
    }

    return { result: parsed };
  },
};

const CLICK_ACTIONS = ['click', 'double_click', 'right_click'] as const;

/**
 * `visual_click` — locate a described target on the desktop and click it in one step. Runs the same
 * vision localization (+ OCR text snap) as `visual_screenshot`, then clicks the resolved pixel via the
 * pyautogui driver. This keeps the text agent out of coordinate-handling — the
 * main cause of misplaced clicks — so prefer it over `visual_screenshot` + `visual_act` for clicking a
 * described element. Streams a marker card + a live-desktop pulse showing exactly where it clicked.
 */
export const visualClick: Tool = {
  name: 'visual_click',
  description:
    "Locate a described element on the agent's desktop and click it in one step — more accurate than " +
    'reading coordinates from visual_screenshot and passing them to visual_act. Describe the target in ' +
    '`target` (e.g. "the green Submit button", "the address bar", "the File menu"). Optional `action`: ' +
    'click (default), double_click, or right_click. Returns the pixel it clicked and the vision ' +
    "model's reasoning. For closing/focusing windows, prefer visual_windows (exact geometry).",
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Natural-language description of the element to click, e.g. "the Submit button".',
      },
      action: {
        type: 'string',
        enum: [...CLICK_ACTIONS],
        description: 'Which click to perform (default click).',
      },
    },
    required: ['target'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const target = String(args.target ?? '').trim();
    if (!target) return { result: { ok: false, error: 'provide `target`: describe the element to click.' } };
    const action = normalizeAction(String(args.action ?? 'click'));
    if (!CLICK_ACTIONS.includes(action as (typeof CLICK_ACTIONS)[number])) {
      return { result: { ok: false, error: `visual_click supports ${CLICK_ACTIONS.join('/')}, not ${action}` } };
    }
    const ready = await ensureVisual(ctx);
    if ('error' in ready) return { result: { ok: false, error: ready.error } };
    const exec = ready.exec;

    const loc = await locate(ctx, exec, `Where is ${target}?`);
    if ('error' in loc) return { result: { ok: false, error: loc.error } };
    if (loc.x == null || loc.y == null) {
      return {
        result: {
          ok: false,
          error: `could not locate "${target}" on screen`,
          analysis: loc.analysis,
          ...(loc.model ? { vision_model: loc.model } : {}),
        },
      };
    }

    // Click the resolved pixel via the same driver visual_act uses.
    const b64Args = Buffer.from(JSON.stringify({ action, x: loc.x, y: loc.y })).toString('base64');
    const command = [DISPLAY_ENV, "python3 - <<'PLEIADES_VISUAL_PY'", actScript(b64Args), 'PLEIADES_VISUAL_PY'].join('\n');
    const res = await exec.run(command, { timeoutMs: TIMEOUT_MS });
    if (res.timedOut) return { result: { ok: false, error: 'visual_click timed out' } };
    const line = res.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return {
        result: { ok: false, error: `visual_click failed: ${res.stderr.trim() || res.stdout.trim() || 'no output'}` },
      };
    }

    // Marker card + live pulse over the clean located frame, at the clicked pixel.
    ctx.emitVisualAct?.({ image: loc.thumbClean, width: loc.width, height: loc.height, action, x: loc.x, y: loc.y, snap: loc.snap });
    log.info({ agent: ctx.agentName, target, action, x: loc.x, y: loc.y, model: loc.model || null }, 'visual click');
    return {
      result: {
        ...parsed,
        target,
        located: { x: loc.x, y: loc.y },
        analysis: loc.analysis,
        ...(loc.model ? { vision_model: loc.model } : {}),
      },
    };
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
      "python3 - <<'PLEIADES_VISUAL_PY'",
      windowsScript(b64Args),
      'PLEIADES_VISUAL_PY',
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
