import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { resourceRepository } from '../../domain/resources/resource.repository';
import { readResourceBytes, unknownHandleError } from './resource-bytes';
import { ComfyError } from '../../media/comfy/errors';
import {
  generateMedia,
  watchDetachedJob,
  type GenerateOutcome,
  type InputImage,
} from '../../media/media-generate.service';
import { readFileBytes } from './fs/env-fs';
import type { BindingValues } from '../../media/comfy/graph-introspect';
import type { WorkflowKind } from '../../domain/media-workflows/media-workflow.model';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { Tool, ToolConfigField, ToolContext, ToolResult } from '../types';

const log = createLogger('tool:media');

/** Hard ceiling on images per call — one slow render shouldn't be able to queue dozens. */
const MAX_BATCH = 4;
/** Longest edge an input image is scaled to before upload (a phone photo is pointless at 4000px). */
const DEFAULT_MAX_INPUT_DIMENSION = 1536;

/** The workflow picker every media tool shares — options are filled from the database at read time. */
function workflowField(kind: WorkflowKind, hint: string): ToolConfigField {
  return {
    key: 'workflow',
    label: 'ComfyUI workflow',
    type: 'select',
    optionsSource: `media_workflows:${kind}`,
    default: '',
    hint,
  };
}

function waitField(seconds: number, hint: string): ToolConfigField {
  return { key: 'wait_timeout_seconds', label: 'Wait timeout (s)', type: 'number', default: seconds, hint };
}

const SEED_FIELDS: ToolConfigField[] = [
  {
    key: 'seed_mode',
    label: 'Seed',
    type: 'select',
    options: ['random', 'fixed'],
    default: 'random',
    hint: 'Random draws a new seed per call. Fixed reuses the seed below, so the same prompt reproduces the same result.',
  },
  { key: 'seed', label: 'Fixed seed', type: 'number', default: 0, hint: 'Used only when Seed is "fixed".' },
];

const IGNORED_NOTE =
  ' Ignored when the selected workflow does not expose that parameter (the Media page lists which).';

const IMAGE_CONFIG: ToolConfigField[] = [
  workflowField('image', 'Which imported ComfyUI workflow generates the image. Import one on the Media page.'),
  {
    key: 'size',
    label: 'Size',
    type: 'select',
    options: ['1024x1024', '1344x768', '768x1344', '1216x832', '832x1216', '768x768', '512x512'],
    default: '1024x1024',
    hint: 'Output dimensions, snapped to whatever grid the model requires.' + IGNORED_NOTE,
  },
  { key: 'batch', label: 'Count', type: 'number', default: 1, hint: `Images per call (max ${MAX_BATCH}).` + IGNORED_NOTE },
  {
    key: 'negative_prompt',
    label: 'Negative prompt',
    type: 'string',
    default: '',
    hint: 'What to avoid in every image.' + IGNORED_NOTE,
  },
  ...SEED_FIELDS,
  waitField(300, 'How long to block the agent before handing the job off to a background watcher.'),
];

const VIDEO_CONFIG: ToolConfigField[] = [
  workflowField('video', 'Which imported ComfyUI workflow generates the video.'),
  {
    key: 'seconds',
    label: 'Duration (s)',
    type: 'number',
    default: 5,
    hint: 'Converted to frames using the fps below and snapped to the model\'s frame grid.' + IGNORED_NOTE,
  },
  { key: 'fps', label: 'FPS', type: 'number', default: 24, hint: 'Frame rate of the output.' + IGNORED_NOTE },
  {
    key: 'size',
    label: 'Size',
    type: 'select',
    options: ['auto', '1344x768', '768x1344', '1024x576', '576x1024', '832x480'],
    default: 'auto',
    hint: '"auto" keeps whatever the workflow was built with.' + IGNORED_NOTE,
  },
  ...SEED_FIELDS,
  waitField(1200, 'Video is slow — measured runs on this hardware take ~10 minutes for 5 seconds.'),
];

const SOUND_CONFIG: ToolConfigField[] = [
  workflowField('audio', 'Which imported ComfyUI workflow generates the audio.'),
  { key: 'seconds', label: 'Duration (s)', type: 'number', default: 30, hint: 'Length of the clip.' + IGNORED_NOTE },
  {
    key: 'negative_prompt',
    label: 'Negative prompt',
    type: 'string',
    default: '',
    hint: 'Qualities to avoid.' + IGNORED_NOTE,
  },
  ...SEED_FIELDS,
  waitField(600, 'How long to block the agent before handing the job off to a background watcher.'),
];

const EDIT_CONFIG: ToolConfigField[] = [
  workflowField('edit', 'Which imported ComfyUI workflow edits the image (it must contain a Load Image node).'),
  {
    key: 'max_input_dimension',
    label: 'Max input size (px)',
    type: 'number',
    default: DEFAULT_MAX_INPUT_DIMENSION,
    hint: 'Longest edge accepted for the source image. Larger inputs are rejected rather than silently resized.',
  },
  ...SEED_FIELDS,
  waitField(300, 'How long to block the agent before handing the job off to a background watcher.'),
];

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** `1344x768` → `{width, height}`; `auto`/garbage → nothing, leaving the workflow's own values. */
function parseSize(value: unknown): { width?: number; height?: number } {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(value ?? '').trim());
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function seedFrom(config: Record<string, unknown>): number | undefined {
  if (String(config.seed_mode ?? 'random') !== 'fixed') return undefined;
  const seed = Number(config.seed);
  return Number.isFinite(seed) ? Math.trunc(seed) : undefined;
}

/** Bridge the socket's progress into the tool context's structured event + occasional text milestones. */
function progressReporter(ctx: ToolContext, label: string) {
  let lastMilestone = -1;
  return (p: Parameters<NonNullable<ToolContext['emitProgress']>>[0]): void => {
    ctx.emitProgress?.(p);
    // The bar is live-only; these lines are what survives in the persisted turn, so keep them sparse.
    const bucket = Math.floor((p.percent ?? 0) / 25);
    if (p.phase === 'running' && bucket > lastMilestone) {
      lastMilestone = bucket;
      ctx.emitOutput?.(`${label}: ${p.percent}%${p.nodeLabel ? ` — ${p.nodeLabel}` : ''}\n`);
    }
  };
}

/**
 * Turn a completed run into the tool's answer: images ride back as context-bearing `images` (the
 * runner pools, persists and folds them into a multimodal agent's context), while video and audio are
 * stored here as blobs and handed over by handle — they are far too large to inline and no model can
 * perceive them anyway.
 */
async function packageResult(
  ctx: ToolContext,
  outcome: Extract<GenerateOutcome, { status: 'done' }>,
  extra: { params: Record<string, string | number>; negativePrompt: string | null; sourceId?: string | null },
): Promise<ToolResult> {
  const images: ImageBlock[] = [];
  const resources: ImageBlock[] = [];
  const handles: string[] = [];

  for (const file of outcome.files) {
    if (file.kind === 'image') {
      // No storageId: the runner stores it, assigns `img_N`, and puts it in context.
      images.push({
        dataUrl: `data:${file.mime};base64,${file.bytes.toString('base64')}`,
        kind: 'image',
        source: 'tool',
      });
      continue;
    }
    const stored = await resourceRepository.store({
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      bytes: file.bytes,
      kind: 'blob',
      mime: file.mime,
      filename: file.filename,
      source: 'tool',
    });
    handles.push(stored.handle);
    resources.push({
      id: stored.handle,
      kind: 'blob',
      mime: file.mime,
      size: file.bytes.length,
      filename: file.filename,
      storageId: String(stored.gridfs_id),
      source: 'tool',
    });
  }

  const kind = outcome.files[0]?.kind === 'image' ? 'image' : (outcome.files[0]?.kind ?? 'image');
  ctx.emitMediaGen?.({
    phase: 'done',
    kind: kind === 'other' ? 'image' : kind,
    prompt: extra.params.prompt ? String(extra.params.prompt) : '',
    negativePrompt: extra.negativePrompt,
    workflow: outcome.workflow.name,
    seed: outcome.seed,
    params: extra.params,
    count: outcome.files.length,
    resourceIds: handles,
    sourceId: extra.sourceId ?? null,
  });

  const first = outcome.files[0];
  return {
    result: {
      ok: true,
      count: outcome.files.length,
      workflow: outcome.workflow.name,
      seed: outcome.seed,
      duration_ms: outcome.durationMs,
      ...extra.params,
      ...(handles.length > 0
        ? {
            resource_id: handles[0],
            mime: first?.mime,
            filename: first?.filename,
            size: first?.bytes.length,
            note:
              `Saved as ${handles.join(', ')}. Write it to a file with write(from_handle: "${handles[0]}"), ` +
              'or hand the handle to another agent — it plays inline in the chat and the Data tab.',
          }
        : {}),
    },
    ...(images.length > 0 ? { images } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  };
}

/** Shared body: run the workflow, or explain why it couldn't, without ever throwing at the agent. */
async function runMediaTool(
  ctx: ToolContext,
  opts: {
    toolName: string;
    expectKind: WorkflowKind;
    schema: ToolConfigField[];
    prompt: string;
    values: BindingValues;
    negativePrompt: string | null;
    params: Record<string, string | number>;
    inputImages?: InputImage[];
    sourceId?: string | null;
  },
): Promise<ToolResult> {
  const { config } = await toolConfigService.resolve(opts.toolName, opts.schema);
  const waitSeconds = clampInt(config.wait_timeout_seconds, 30, 1800, 300);

  try {
    const outcome = await generateMedia({
      workflowId: String(config.workflow ?? ''),
      expectKind: opts.expectKind,
      prompt: opts.prompt,
      negativePrompt: opts.negativePrompt ?? undefined,
      values: { ...opts.values, ...(seedFrom(config) !== undefined ? { seed: seedFrom(config) } : {}) },
      inputImages: opts.inputImages,
      timeoutMs: waitSeconds * 1000,
      onProgress: progressReporter(ctx, opts.toolName),
      // Announce the run the moment ComfyUI takes it, so the card names the workflow and its models
      // for the whole render rather than only once the artifact lands.
      onStart: (info) =>
        ctx.emitMediaGen?.({
          phase: 'start',
          kind: info.outputKind,
          prompt: opts.prompt,
          negativePrompt: opts.negativePrompt,
          workflow: info.workflow,
          workflowKind: info.workflowKind,
          models: info.models,
          promptId: info.promptId,
          comfyUrl: info.comfyUrl,
          queuePosition: info.queuePosition,
          vramFreeBytes: info.vramFreeBytes,
          vramTotalBytes: info.vramTotalBytes,
          seed: info.seed,
          params: { prompt: opts.prompt, ...opts.params },
          sourceId: opts.sourceId ?? null,
        }),
      signal: ctx.signal,
      sessionId: ctx.sessionId,
    });

    if (outcome.status === 'aborted') {
      return { result: { ok: false, error: 'Cancelled — the ComfyUI job was dropped from the queue.' } };
    }
    if (outcome.status === 'timeout') {
      // Don't throw away a nearly-finished render: keep waiting in the background and tell the agent
      // where the result will show up.
      watchDetachedJob({
        promptId: outcome.promptId,
        workflow: outcome.workflow,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
      });
      return {
        result: {
          ok: false,
          status: 'still_running',
          workflow: outcome.workflow.name,
          waited_seconds: waitSeconds,
          note:
            'The job is still rendering and has been left running. It will appear in this session\'s ' +
            'Data tab (list it with the `data` tool) and in the notifications inbox when it lands.',
        },
      };
    }

    log.info(
      { agent: ctx.agentName, tool: opts.toolName, workflow: outcome.workflow.name, ms: outcome.durationMs },
      'media generated',
    );
    return packageResult(ctx, outcome, {
      params: { prompt: opts.prompt, ...opts.params },
      negativePrompt: opts.negativePrompt,
      sourceId: opts.sourceId,
    });
  } catch (err) {
    // Configuration, connectivity and node failures are expected states the agent should relay, not
    // exceptions that abort its turn.
    if (err instanceof ComfyError) return { result: { ok: false, error: err.message } };
    throw err;
  }
}

/**
 * `generate_image` — text to image through a ComfyUI workflow the operator selected on the Tools page.
 * The image is pooled as an `img_N` resource, rendered in the chat, and folded into a multimodal
 * agent's context.
 */
export const generateImage: Tool = {
  name: 'generate_image',
  description:
    'Generate an image from a text description using the configured ComfyUI workflow. Give a vivid, ' +
    'detailed `prompt` (subject, style, lighting, composition) — that is the only input. Size, count, ' +
    'seed and negative prompt are set by the operator on the Tools page, not per call. The image is ' +
    'saved as an `img_N` resource you can write to a file or hand to another agent.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to depict — be specific about subject, style, lighting, and composition.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  configSchema: IMAGE_CONFIG,

  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { result: { ok: false, error: 'prompt is required' } };

    const { config } = await toolConfigService.resolve(generateImage.name, IMAGE_CONFIG);
    const size = parseSize(config.size);
    const batch = clampInt(config.batch, 1, MAX_BATCH, 1);
    const negativePrompt = String(config.negative_prompt ?? '').trim() || null;

    return runMediaTool(ctx, {
      toolName: generateImage.name,
      expectKind: 'image',
      schema: IMAGE_CONFIG,
      prompt,
      values: { ...size, batch },
      negativePrompt,
      params: { size: String(config.size ?? ''), count: batch },
    });
  },
};

/**
 * `generate_video` — text to video. Slow by nature: a five-second clip measured 9-10 minutes on this
 * hardware, so the tool blocks with a progress bar and hands off to a background watcher if the
 * operator's timeout runs out first.
 */
export const generateVideo: Tool = {
  name: 'generate_video',
  description:
    'Generate a short video from a text description using the configured ComfyUI workflow. Describe ' +
    'the shot: subject, action, camera movement, lighting, mood — and the soundtrack too if the ' +
    'workflow produces audio. Duration, fps and size come from the Tools page. This is SLOW (minutes ' +
    'per clip). The result is saved as a `blob_N` resource handle, not shown to you directly.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The shot to render — subject, action, camera, lighting, mood.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  configSchema: VIDEO_CONFIG,

  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { result: { ok: false, error: 'prompt is required' } };

    const { config } = await toolConfigService.resolve(generateVideo.name, VIDEO_CONFIG);
    const fps = clampInt(config.fps, 1, 120, 24);
    const seconds = clampInt(config.seconds, 1, 60, 5);
    const size = parseSize(config.size);

    return runMediaTool(ctx, {
      toolName: generateVideo.name,
      expectKind: 'video',
      schema: VIDEO_CONFIG,
      prompt,
      // Frame count is what the model actually takes; `applyBindings` snaps it to the grid the node
      // declares (MiniMax H3 wants 17k+5, so 5s@24fps → 124 frames, not 120).
      values: { ...size, fps, length: seconds * fps },
      negativePrompt: null,
      params: { seconds, fps },
    });
  },
};

/** `generate_sound` — text to audio (music, ambience, effects) through a ComfyUI workflow. */
export const generateSound: Tool = {
  name: 'generate_sound',
  description:
    'Generate audio — music, ambience or a sound effect — from a text description using the configured ' +
    'ComfyUI workflow. Describe genre, instruments, tempo, mood and production style. Duration comes ' +
    'from the Tools page. The result is saved as a `blob_N` resource handle you can write to a file.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The audio to produce — genre, instruments, tempo, mood, production style.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  configSchema: SOUND_CONFIG,

  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { result: { ok: false, error: 'prompt is required' } };

    const { config } = await toolConfigService.resolve(generateSound.name, SOUND_CONFIG);
    const seconds = clampInt(config.seconds, 1, 600, 30);
    const negativePrompt = String(config.negative_prompt ?? '').trim() || null;

    return runMediaTool(ctx, {
      toolName: generateSound.name,
      expectKind: 'audio',
      schema: SOUND_CONFIG,
      prompt,
      values: { seconds },
      negativePrompt,
      params: { seconds },
    });
  },
};

/** Sniff the container format so an upload gets an honest mime and extension. */
function sniffImage(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { mime: 'image/png', ext: 'png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (bytes.subarray(0, 6).toString('ascii').startsWith('GIF8')) return { mime: 'image/gif', ext: 'gif' };
  return null;
}

/**
 * Resolve the tool's `image` argument to bytes. A resource handle (`img_2`, `blob_1`) reads from the
 * session store; anything else is treated as a path and read through the agent's own filesystem —
 * which for an isolated agent means inside its container, or over SSH, transparently.
 */
async function resolveInputImage(ctx: ToolContext, ref: string): Promise<InputImage> {
  const isHandle = /^(img|blob)_\d+$/.test(ref);
  const bytes = isHandle
    ? await readResourceBytes(ctx, ref)
    : await readFileBytes(ctx, ref).catch(() => null);

  if (!bytes || bytes.length === 0) {
    throw new ComfyError(
      isHandle
        ? `No ${unknownHandleError(ctx, ref)}`
        : `Could not read "${ref}" — give a path that exists, or a resource handle like img_1.`,
    );
  }
  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw new ComfyError(`"${ref}" doesn't look like an image (expected PNG, JPEG, WebP or GIF).`);
  }
  const base = ref.split('/').filter(Boolean).pop() ?? 'input';
  return { bytes, mime: sniffed.mime, filename: `${base}.${sniffed.ext}` };
}

/**
 * `edit_image` — image + instruction in, edited image out, through a ComfyUI edit workflow. The source
 * is uploaded to ComfyUI and wired into the workflow's Load Image node; the result comes back as a new
 * `img_N`, so edits can be chained.
 */
export const editImage: Tool = {
  name: 'edit_image',
  description:
    'Edit an existing image from a text instruction, using the configured ComfyUI workflow. `image` is ' +
    'either a resource handle you already have (e.g. "img_2", including one you just generated) or a ' +
    'path to an image file in your workspace. `prompt` says what to change — be specific about what ' +
    'to keep as well as what to alter. The edited image comes back as a new `img_N`, so you can edit ' +
    'again from there.',
  parameters: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: 'Resource handle (e.g. "img_2") or a path to the image file to edit.',
      },
      prompt: {
        type: 'string',
        description: 'The edit to make — what should change, and what should stay the same.',
      },
    },
    required: ['image', 'prompt'],
    additionalProperties: false,
  },
  configSchema: EDIT_CONFIG,

  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    const ref = String(args.image ?? '').trim();
    if (!prompt) return { result: { ok: false, error: 'prompt is required' } };
    if (!ref) return { result: { ok: false, error: 'image is required (a handle like img_1, or a file path)' } };

    let input: InputImage;
    try {
      input = await resolveInputImage(ctx, ref);
    } catch (err) {
      if (err instanceof ComfyError) return { result: { ok: false, error: err.message } };
      throw err;
    }

    return runMediaTool(ctx, {
      toolName: editImage.name,
      expectKind: 'edit',
      schema: EDIT_CONFIG,
      prompt,
      values: {},
      negativePrompt: null,
      params: { source: ref },
      inputImages: [input],
      sourceId: /^(img|blob)_\d+$/.test(ref) ? ref : null,
    });
  },
};
