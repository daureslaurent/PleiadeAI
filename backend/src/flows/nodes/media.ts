import { createLogger } from '../../config/logger';
import type { WorkflowKind } from '../../domain/media-workflows/media-workflow.model';
import { generateMedia, MAX_WAIT_MS, type InputImage } from '../../media/media-generate.service';
import type { BindingValues } from '../../media/comfy/graph-introspect';
import { asHandles, asText, handleValue, type FlowValue } from '../port-types';
import type { FlowNodeContext, FlowNodeHandler, PortSpec } from '../types';
import type { ToolConfigField } from '../../tools/types';

const log = createLogger('flow:media-node');

/** Hard ceiling on images per node — one slow render shouldn't be able to queue dozens. */
const MAX_BATCH = 4;

const IGNORED_NOTE = ' Ignored when the selected workflow does not expose that parameter.';

function workflowField(kind: WorkflowKind): ToolConfigField {
  return {
    key: 'workflow',
    label: 'ComfyUI workflow',
    type: 'select',
    optionsSource: `media_workflows:${kind}`,
    default: '',
    hint: 'Which imported ComfyUI workflow this node runs. Import one on the Media page.',
  };
}

const PROMPT_FIELD: ToolConfigField = {
  key: 'prompt',
  label: 'Prompt',
  type: 'string',
  default: '',
  hint: 'Supports {{node_id}} references. Text arriving on the prompt port is appended.',
};

const SEED_FIELDS: ToolConfigField[] = [
  {
    key: 'seed_mode',
    label: 'Seed',
    type: 'select',
    options: ['random', 'fixed'],
    default: 'random',
    hint: 'Fixed reuses the seed below, so the same prompt reproduces the same result.',
  },
  { key: 'seed', label: 'Fixed seed', type: 'number', default: 0, hint: 'Used only when Seed is "fixed".' },
];

function waitField(seconds: number, hint: string): ToolConfigField {
  return { key: 'wait_timeout_seconds', label: 'Wait timeout (s)', type: 'number', default: seconds, hint };
}

const SHARED_INPUTS: PortSpec[] = [
  { name: 'prompt', types: ['text', 'json'], description: 'Appended to the prompt field.' },
  { name: 'run', types: ['signal'], description: 'Optional ordering-only trigger.' },
];

/**
 * Port names a workflow parameter may not take, because the node already means something by them.
 * The inspector filters these out too; this is the backstop.
 */
const RESERVED_PARAM_NAMES = new Set(['prompt', 'run', 'image', 'audio', 'video', 'default', 'done']);

/**
 * The custom parameters the operator has taken up on this node, from `config.params`.
 *
 * Which parameters *exist* is a property of the selected ComfyUI workflow (its `custom:` bindings),
 * and the backend is the authority on that at run time. But ports have to be derivable from the node
 * alone, synchronously, for both the canvas and validation — so the inspector copies the ones in use
 * into `config.params` when the workflow is picked, exactly as the router stores its choices.
 */
function paramKeys(config: Record<string, unknown>): string[] {
  const params = config.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.keys(params as Record<string, unknown>).filter(
    (k) => /^[a-z][a-z0-9_]{0,31}$/.test(k) && !RESERVED_PARAM_NAMES.has(k),
  );
}

/** One extra input port per custom parameter, so an agent node can decide it per run. */
function withParamPorts(base: PortSpec[]): (config: Record<string, unknown>) => PortSpec[] {
  return (config) => [
    ...base,
    ...paramKeys(config).map((name) => ({
      name,
      types: ['text' as const],
      description: `Workflow parameter "${name}" — overrides the value set on this node.`,
    })),
  ];
}

/**
 * Values for the selected workflow's custom parameters: the node's own field, overridden by whatever
 * arrives on the matching port. Keyed the way the workflow's bindings are (`custom:<name>`); a name
 * the workflow doesn't declare is simply ignored downstream.
 */
function customParams(
  config: Record<string, unknown>,
  inputs: Record<string, FlowValue>,
): BindingValues {
  const stored = (config.params ?? {}) as Record<string, unknown>;
  const out: BindingValues = {};
  for (const key of paramKeys(config)) {
    const wired = inputs[key] ? asText(inputs[key]).trim() : '';
    const value = wired || stored[key];
    if (value === undefined || value === null || value === '') continue;
    out[`custom:${key}`] = typeof value === 'number' ? value : String(value);
  }
  return out;
}

function outputsFor(type: 'image' | 'video' | 'audio'): PortSpec[] {
  return [
    { name: 'default', types: [type] },
    { name: 'done', types: ['signal'] },
  ];
}

/** `1344x768` → `{width, height}`; `auto`/garbage → nothing, leaving the workflow's own values. */
function parseSize(value: unknown): { width?: number; height?: number } {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(String(value ?? '').trim());
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function seedFrom(config: Record<string, unknown>): number | undefined {
  if (String(config.seed_mode ?? 'random') !== 'fixed') return undefined;
  const seed = Number(config.seed);
  return Number.isFinite(seed) ? Math.trunc(seed) : undefined;
}

function timeoutFrom(config: Record<string, unknown>, fallbackSeconds: number): number {
  const seconds = Number(config.wait_timeout_seconds);
  const ms = (Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds) * 1000;
  return Math.min(ms, MAX_WAIT_MS);
}

/**
 * Run one ComfyUI workflow and file its artifacts in the run's session.
 *
 * Unlike the media *tools*, a node never inlines pixels: images and video alike are stored and handed
 * on as handles (flows spec §2). A downstream agent node loads them back into context by handle, and
 * the run panel previews them through the resource content route — the same one the Data tab uses.
 */
async function runWorkflow(
  ctx: FlowNodeContext,
  kind: WorkflowKind,
  outputType: 'image' | 'video' | 'audio',
  config: Record<string, unknown>,
  prompt: string,
  values: BindingValues,
  inputImages: InputImage[] | undefined,
  fallbackTimeoutSeconds: number,
  inputAudios?: InputImage[] | undefined,
  inputVideo?: InputImage | undefined,
): Promise<Record<string, FlowValue>> {
  const workflowId = String(config.workflow ?? '').trim();
  if (!workflowId) throw new Error('no ComfyUI workflow is selected for this node (pick one in the inspector)');
  // The empty-prompt guard exists so a blank field can't silently regenerate the workflow author's
  // own prompt. That reasoning does not hold when a source clip is supplied: the operation is defined
  // by the clip and the graph, and the prompt slot is often an optional hint — Whisper's, for
  // instance, is a vocabulary nudge that is meant to be empty.
  if (!prompt.trim() && !inputVideo) throw new Error('the prompt is empty');

  const seed = seedFrom(config);
  const started = Date.now();

  const outcome = await generateMedia({
    workflowId,
    expectKind: kind,
    prompt,
    negativePrompt: String(config.negative_prompt ?? '') || undefined,
    values: { ...values, ...(seed !== undefined ? { seed } : {}) },
    inputImages,
    inputAudios,
    inputVideo,
    timeoutMs: timeoutFrom(config, fallbackTimeoutSeconds),
    sessionId: ctx.sessionId,
    signal: ctx.signal,
    onProgress: (p) =>
      ctx.emitProgress({
        phase: p.phase,
        percent: p.percent,
        message: p.nodeLabel ?? p.message,
        preview: p.preview,
        etaMs: p.etaMs,
      }),
    onStart: (info) => {
      ctx.emitOutput(
        `queued on ${info.comfyUrl} (${info.workflow}, seed ${info.seed}` +
          `${info.queuePosition ? `, ${info.queuePosition} ahead` : ''})\n`,
      );
    },
  });

  if (outcome.status === 'timeout') {
    // Unlike the tool path, a flow node does not detach the job: a pipeline whose next step needs the
    // artifact has nothing to do with a result that arrives an hour later, and silently continuing
    // with an empty value would corrupt everything downstream.
    throw new Error(
      `the ComfyUI job did not finish within the wait timeout (prompt ${outcome.promptId}); ` +
        'raise "Wait timeout" on this node, or check the ComfyUI server',
    );
  }
  if (outcome.status === 'aborted') throw new Error('the run was stopped');

  const handles: string[] = [];
  for (const file of outcome.files) {
    handles.push(
      await ctx.storeResource({
        bytes: file.bytes,
        kind: file.kind === 'image' ? 'image' : 'blob',
        mime: file.mime,
        filename: file.filename,
      }),
    );
  }
  if (handles.length === 0) throw new Error('the workflow produced no output files');

  log.info(
    { runId: ctx.runId, node: ctx.node.id, handles, ms: Date.now() - started },
    'flow media node complete',
  );
  ctx.emitOutput(`produced ${handles.join(', ')} in ${Math.round(outcome.durationMs / 1000)}s\n`);

  return { default: handleValue(outputType, handles), done: { type: 'signal' } };
}

/** Prompt = the config field plus whatever text is wired into the prompt port. */
function promptOf(config: Record<string, unknown>, wired: string): string {
  const base = String(config.prompt ?? '').trim();
  if (base && wired) return `${base}\n\n${wired}`;
  return base || wired;
}

export const generateImageNode: FlowNodeHandler = {
  type: 'generate_image',
  label: 'Generate Image',
  group: 'media',
  description: 'Renders an image on ComfyUI with the selected workflow.',
  inputs: SHARED_INPUTS,
  dynamicInputs: withParamPorts(SHARED_INPUTS),
  outputs: outputsFor('image'),
  config: [
    workflowField('image'),
    PROMPT_FIELD,
    {
      key: 'size',
      label: 'Size',
      type: 'select',
      options: ['1024x1024', '1344x768', '768x1344', '1216x832', '832x1216', '768x768', '512x512'],
      default: '1024x1024',
      hint: 'Output dimensions.' + IGNORED_NOTE,
    },
    { key: 'batch', label: 'Count', type: 'number', default: 1, hint: `Images per run (max ${MAX_BATCH}).` + IGNORED_NOTE },
    { key: 'negative_prompt', label: 'Negative prompt', type: 'string', default: '', hint: 'What to avoid.' + IGNORED_NOTE },
    ...SEED_FIELDS,
    waitField(300, 'How long to wait for ComfyUI before failing this node.'),
  ],

  async run(ctx, inputs, config) {
    return runWorkflow(
      ctx,
      'image',
      'image',
      config,
      promptOf(config, asText(inputs.prompt)),
      { ...customParams(config, inputs), ...parseSize(config.size), batch: clampInt(config.batch, 1, MAX_BATCH, 1) },
      undefined,
      300,
    );
  },
};

const VIDEO_INPUTS: PortSpec[] = [
  ...SHARED_INPUTS,
  { name: 'image', types: ['image'], description: 'Start frame, if the workflow takes one.' },
  {
    name: 'audio',
    types: ['audio'],
    description:
      'Soundtrack the model paces its motion to (LTX-style A/V models). Only for a workflow with a LoadAudio node.',
  },
  {
    name: 'video',
    types: ['video', 'file'],
    description:
      'Source clip, for a workflow that transforms video rather than creating it (subtitling, restyling, interpolation). Only for a workflow with a LoadVideo node.',
  },
];

export const generateVideoNode: FlowNodeHandler = {
  type: 'generate_video',
  label: 'Generate Video',
  group: 'media',
  description:
    'Runs a video workflow on ComfyUI — from a prompt, a start frame, or an existing clip. Slow and GPU-expensive.',
  inputs: VIDEO_INPUTS,
  dynamicInputs: withParamPorts(VIDEO_INPUTS),
  outputs: outputsFor('video'),
  config: [
    workflowField('video'),
    PROMPT_FIELD,
    { key: 'seconds', label: 'Duration (s)', type: 'number', default: 5, hint: 'Converted to frames via fps.' + IGNORED_NOTE },
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
    waitField(1800, 'Video is slow — measured runs take ~10 minutes for 5 seconds.'),
  ],

  async run(ctx, inputs, config) {
    const seconds = clampInt(config.seconds, 1, 60, 5);
    const fps = clampInt(config.fps, 1, 60, 24);
    // A workflow that transforms a clip sizes and times itself from that clip, so width/height/length
    // are left alone — forcing them would fight the source and, for a subtitling pass, silently
    // re-crop the film.
    const source = await inputVideoFrom(ctx, asHandles(inputs.video));
    const values = source
      ? { ...customParams(config, inputs), ...parseSize(config.size), fps }
      : { ...customParams(config, inputs), ...parseSize(config.size), seconds, fps, length: seconds * fps };

    return runWorkflow(
      ctx,
      'video',
      'video',
      config,
      promptOf(config, asText(inputs.prompt)),
      values,
      await inputImagesFrom(ctx, asHandles(inputs.image)),
      1800,
      await inputImagesFrom(ctx, asHandles(inputs.audio)),
      source,
    );
  },
};

export const generateSoundNode: FlowNodeHandler = {
  type: 'generate_sound',
  label: 'Generate Sound',
  group: 'media',
  description: 'Renders audio on ComfyUI with the selected workflow.',
  inputs: SHARED_INPUTS,
  dynamicInputs: withParamPorts(SHARED_INPUTS),
  outputs: outputsFor('audio'),
  config: [
    workflowField('audio'),
    PROMPT_FIELD,
    { key: 'seconds', label: 'Duration (s)', type: 'number', default: 30, hint: 'Length of the clip.' + IGNORED_NOTE },
    { key: 'negative_prompt', label: 'Negative prompt', type: 'string', default: '', hint: 'Qualities to avoid.' + IGNORED_NOTE },
    ...SEED_FIELDS,
    waitField(600, 'How long to wait for ComfyUI before failing this node.'),
  ],

  async run(ctx, inputs, config) {
    return runWorkflow(
      ctx,
      'audio',
      'audio',
      config,
      promptOf(config, asText(inputs.prompt)),
      { ...customParams(config, inputs), seconds: clampInt(config.seconds, 1, 600, 30) },
      undefined,
      600,
    );
  },
};

/**
 * `animate_image` — turn a still into a clip with a generative model (image-to-video).
 *
 * `generate_video` can also accept an image, but its workflow list includes every video graph, and a
 * text-to-video one silently ignores — or outright refuses — the picture you wired in. Here the image
 * is **required** and the node is named for the job, so the pairing is obvious on the canvas: the
 * image node feeds this, and this is what moves it.
 */
const ANIMATE_INPUTS: PortSpec[] = [
  { name: 'image', types: ['image'], required: true, description: 'The frame to animate.' },
  ...SHARED_INPUTS,
  {
    name: 'audio',
    types: ['audio'],
    description: 'Soundtrack the model paces its motion to, if the workflow takes one.',
  },
];

export const animateImageNode: FlowNodeHandler = {
  type: 'animate_image',
  label: 'Animate Image',
  group: 'media',
  description: 'Turns a still into a clip with a generative video model (image-to-video).',
  inputs: ANIMATE_INPUTS,
  dynamicInputs: withParamPorts(ANIMATE_INPUTS),
  outputs: outputsFor('video'),
  config: [
    workflowField('video'),
    {
      ...PROMPT_FIELD,
      label: 'Motion',
      hint: 'How the shot moves — "slow push in", "pan left". One simple motion works far better than several.',
    },
    { key: 'seconds', label: 'Duration (s)', type: 'number', default: 5, hint: 'Converted to frames via fps.' + IGNORED_NOTE },
    { key: 'fps', label: 'FPS', type: 'number', default: 25, hint: 'Frame rate of the output.' + IGNORED_NOTE },
    {
      key: 'size',
      label: 'Size',
      type: 'select',
      options: ['auto', '1344x768', '768x1344', '1024x576', '576x1024', '832x480'],
      default: 'auto',
      hint: '"auto" keeps the workflow\'s own size, which usually means it follows the input image.' + IGNORED_NOTE,
    },
    ...SEED_FIELDS,
    waitField(1800, 'Generative video is slow — minutes per clip on a single GPU.'),
  ],

  async run(ctx, inputs, config) {
    const sources = await inputImagesFrom(ctx, asHandles(inputs.image));
    if (!sources?.length) throw new Error('no image is wired into this node');
    const seconds = clampInt(config.seconds, 1, 60, 5);
    const fps = clampInt(config.fps, 1, 60, 25);
    return runWorkflow(
      ctx,
      'video',
      'video',
      config,
      promptOf(config, asText(inputs.prompt)),
      { ...customParams(config, inputs), ...parseSize(config.size), seconds, fps, length: seconds * fps },
      sources,
      1800,
      await inputImagesFrom(ctx, asHandles(inputs.audio)),
    );
  },
};

/**
 * `edit_video` — video in, video out: restyle, upscale, interpolate, relight.
 *
 * Its own workflow kind (`video_edit`) rather than a flag on `generate_video`, because the two are
 * not interchangeable: a text-to-video graph has no `LoadVideo` to receive a clip, and offering it
 * here would only produce a run that fails after the queue wait.
 */
const EDIT_VIDEO_INPUTS: PortSpec[] = [
  { name: 'video', types: ['video', 'file'], required: true, description: 'The clip to transform.' },
  ...SHARED_INPUTS,
  { name: 'image', types: ['image'], description: 'Style or identity reference, if the workflow takes one.' },
];

export const editVideoNode: FlowNodeHandler = {
  type: 'edit_video',
  label: 'Edit Video',
  group: 'media',
  description: 'Transforms an existing clip with a ComfyUI workflow (restyle, upscale, interpolate).',
  inputs: EDIT_VIDEO_INPUTS,
  dynamicInputs: withParamPorts(EDIT_VIDEO_INPUTS),
  outputs: outputsFor('video'),
  config: [
    workflowField('video_edit'),
    {
      ...PROMPT_FIELD,
      label: 'Instruction',
      hint: 'What to change about the clip. Supports {{node_id}} references.',
    },
    { key: 'fps', label: 'FPS', type: 'number', default: 0, hint: 'Output frame rate. 0 keeps the workflow\'s own.' + IGNORED_NOTE },
    {
      key: 'size',
      label: 'Size',
      type: 'select',
      options: ['auto', '1920x1080', '1344x768', '1280x720', '768x1344', '832x480'],
      default: 'auto',
      hint: '"auto" keeps whatever the workflow was built with.' + IGNORED_NOTE,
    },
    ...SEED_FIELDS,
    waitField(1800, 'A video-to-video pass runs over every frame — budget like a generation, not an edit.'),
  ],

  async run(ctx, inputs, config) {
    const source = await inputVideoFrom(ctx, asHandles(inputs.video));
    if (!source) throw new Error('no clip is wired into this node');

    const fps = clampInt(config.fps, 0, 120, 0);
    return runWorkflow(
      ctx,
      'video_edit',
      'video',
      config,
      promptOf(config, asText(inputs.prompt)),
      { ...customParams(config, inputs), ...parseSize(config.size), ...(fps > 0 ? { fps } : {}) },
      await inputImagesFrom(ctx, asHandles(inputs.image)),
      1800,
      undefined,
      source,
    );
  },
};

const EDIT_IMAGE_INPUTS: PortSpec[] = [
  { name: 'image', types: ['image'], required: true, description: 'The image to edit.' },
  ...SHARED_INPUTS,
];

export const editImageNode: FlowNodeHandler = {
  type: 'edit_image',
  label: 'Edit Image',
  group: 'media',
  description: 'Transforms an existing image on ComfyUI (image + instruction in, image out).',
  inputs: EDIT_IMAGE_INPUTS,
  dynamicInputs: withParamPorts(EDIT_IMAGE_INPUTS),
  outputs: outputsFor('image'),
  config: [
    workflowField('edit'),
    { ...PROMPT_FIELD, label: 'Instruction', hint: 'What to change. Supports {{node_id}} references.' },
    ...SEED_FIELDS,
    waitField(300, 'How long to wait for ComfyUI before failing this node.'),
  ],

  async run(ctx, inputs, config) {
    const sources = await inputImagesFrom(ctx, asHandles(inputs.image));
    if (!sources?.length) throw new Error('no source image is wired into this node');
    return runWorkflow(ctx, 'edit', 'image', config, promptOf(config, asText(inputs.prompt)), customParams(config, inputs), sources, 300);
  },
};

/** Load one clip handle back into bytes, for a workflow whose `LoadVideo` needs a real file. */
async function inputVideoFrom(ctx: FlowNodeContext, handles: string[]): Promise<InputImage | undefined> {
  if (!handles.length) return undefined;
  const res = await ctx.readResource(handles[0]!);
  if (!res) throw new Error(`resource "${handles[0]}" not found in this run`);
  return { bytes: res.bytes, mime: res.mime, filename: res.filename || `${handles[0]}.mp4` };
}

/** Load handles back into raw bytes for upload to ComfyUI (`LoadImage` needs a real file). */
async function inputImagesFrom(ctx: FlowNodeContext, handles: string[]): Promise<InputImage[] | undefined> {
  if (!handles.length) return undefined;
  const images: InputImage[] = [];
  for (const handle of handles.slice(0, 3)) {
    const res = await ctx.readResource(handle);
    if (!res) throw new Error(`resource "${handle}" not found in this run`);
    images.push({ bytes: res.bytes, mime: res.mime, filename: res.filename || `${handle}.png` });
  }
  return images;
}
