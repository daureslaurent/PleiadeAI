import { createHash } from 'node:crypto';
import type { ComfyHttpClient } from './ComfyHttpClient';
import type {
  BindingKey,
  WorkflowBinding,
  WorkflowBindings,
  WorkflowKind,
} from '../../domain/media-workflows/media-workflow.model';
import type { ComfyGraph, ComfyInputSpec, ComfyLink, ComfyNodeSchema } from './types';

/** Node classes whose files are the run's result. `Preview*` deliberately excluded — it saves nothing. */
const SAVE_CLASS = /^(SaveImage|SaveImageAdvanced|SaveVideo|SaveWEBM|SaveAnimated\w+|SaveAudio\w*|VHS_VideoCombine)$/;
const SAMPLER_CLASS = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/;
const EMPTY_LATENT_CLASS = /^Empty\w*Latent\w*$/;
const VIDEO_SAVE_CLASS = /^(SaveVideo|SaveWEBM|SaveAnimated\w+|VHS_VideoCombine|PreviewVideo)$/;
// `Preview*` counts as a save: it writes a real file (into `temp/`) that `/history` reports and
// `/view` serves, and plenty of published workflows — a TTS graph being the common case — end at a
// preview rather than a save. Without it such a workflow is silently classified as producing images.
const AUDIO_SAVE_CLASS = /^(SaveAudio\w*|PreviewAudio)$/;
/** Video source loaders: the core node and VideoHelperSuite's, which is at least as widely used. */
const VIDEO_LOAD_CLASS = /^(LoadVideo|VHS_LoadVideo\w*)$/;

/** Input names that carry the positive text prompt, in preference order. */
const PROMPT_INPUTS = ['prompt', 'text'];
/** Weight files, as opposed to the many other things a COMBO input can hold. */
const MODEL_FILE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i;
/**
 * ComfyUI's *annotated filepath* form — `some.png [output]` — naming a file in the output or temp
 * folder rather than the input folder a `LoadImage` enum lists. Nodes resolve it via
 * `folder_paths.get_annotated_filepath`, so it is valid despite never appearing in the enum.
 */
const ANNOTATED_FILEPATH = /\s\[(output|input|temp)\]$/;

export type SchemaMap = Map<string, ComfyNodeSchema | null>;

/** `[nodeId, slot]` — an input fed by another node rather than a literal. */
export function isLink(value: unknown): value is ComfyLink {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string';
}

/**
 * Turn one `/object_info` input descriptor into the constraints we care about.
 *
 * ComfyUI encodes these as `[type, options?]` where `type` is either a string (`"INT"`, `"STRING"`,
 * `"MODEL"`…) or an inline list of allowed values (which is how installed model filenames are
 * published — that list is what lets us tell an operator their checkpoint is missing).
 */
export function parseInputSpec(entry: unknown): ComfyInputSpec | null {
  if (!Array.isArray(entry) || entry.length === 0) return null;
  const [rawType, rawOpts] = entry as [unknown, unknown];
  const opts = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {}) as Record<string, unknown>;
  const common = {
    default: opts.default as string | number | boolean | undefined,
    tooltip: typeof opts.tooltip === 'string' ? opts.tooltip : undefined,
  };

  if (Array.isArray(rawType)) return { type: 'ENUM', options: rawType.map(String), ...common };

  const name = String(rawType);
  if (name === 'COMBO') {
    const options = Array.isArray(opts.options) ? opts.options.map(String) : [];
    return { type: 'ENUM', options, ...common };
  }
  if (name === 'INT' || name === 'FLOAT') {
    return {
      type: name,
      min: typeof opts.min === 'number' ? opts.min : undefined,
      max: typeof opts.max === 'number' ? opts.max : undefined,
      step: typeof opts.step === 'number' ? opts.step : undefined,
      ...common,
    };
  }
  if (name === 'STRING') {
    return { type: 'STRING', multiline: opts.multiline === true, ...common };
  }
  if (name === 'BOOLEAN') return { type: 'BOOLEAN', ...common };
  // MODEL / CLIP / VAE / IMAGE / CONDITIONING / LATENT and the COMFY_*_V3 pseudo-types: these are
  // wired between nodes, never typed in.
  return { type: 'LINK', ...common };
}

/** All declared inputs of a class, required and optional together. */
function schemaInputs(schema: ComfyNodeSchema | null): Record<string, unknown> {
  if (!schema?.input) return {};
  return { ...(schema.input.required ?? {}), ...(schema.input.optional ?? {}) };
}

export function specFor(schema: ComfyNodeSchema | null, input: string): ComfyInputSpec | null {
  const entry = schemaInputs(schema)[input];
  return entry === undefined ? null : parseInputSpec(entry);
}

/** Fetch (and cache) the schema of every class the graph uses. */
export async function loadSchemas(client: ComfyHttpClient, graph: ComfyGraph): Promise<SchemaMap> {
  const classes = [...new Set(Object.values(graph).map((n) => n.class_type))];
  const entries = await Promise.all(
    classes.map(async (c) => [c, await client.objectInfo(c)] as const),
  );
  return new Map(entries);
}

/**
 * Node ids are `"9"` in a flat graph and `"57:27"` when the run came from a subgraph, so a plain
 * string sort puts `"105:9"` before `"9"`. Compare segment-wise and numerically.
 */
export function compareNodeIds(a: string, b: string): number {
  const pa = a.split(':');
  const pb = b.split(':');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i] ?? -1);
    const nb = Number(pb[i] ?? -1);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    if (!Number.isFinite(na) || !Number.isFinite(nb)) {
      const cmp = (pa[i] ?? '').localeCompare(pb[i] ?? '');
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

function sortedNodeIds(graph: ComfyGraph): string[] {
  return Object.keys(graph).sort(compareNodeIds);
}

// ---------------------------------------------------------------------------
// Auto-binding
// ---------------------------------------------------------------------------

export interface AutoBindResult {
  bindings: WorkflowBindings;
  output_node_id: string;
  output_kind: 'image' | 'video' | 'audio';
  kind: WorkflowKind;
  /** Logical parameters this graph doesn't expose — the tool's config for them will be ignored. */
  unbound: BindingKey[];
}

/** The result node: what `outputs_to_execute` names, preferring a Save over a Preview. */
function pickOutputNode(graph: ComfyGraph, outputsToExecute: string[], schemas: SchemaMap): string {
  const declared = outputsToExecute.filter((id) => graph[id]);
  const pools = [declared, sortedNodeIds(graph)];
  for (const pool of pools) {
    const save = pool.find((id) => SAVE_CLASS.test(graph[id]?.class_type ?? ''));
    if (save) return save;
  }
  for (const pool of pools) {
    const outputNode = pool.find((id) => {
      const cls = graph[id]?.class_type ?? '';
      return schemas.get(cls)?.output_node === true && !/^Preview/.test(cls);
    });
    if (outputNode) return outputNode;
  }
  return declared[0] ?? sortedNodeIds(graph)[0] ?? '';
}

function outputKindOf(className: string): 'image' | 'video' | 'audio' {
  if (VIDEO_SAVE_CLASS.test(className)) return 'video';
  if (AUDIO_SAVE_CLASS.test(className)) return 'audio';
  return 'image';
}

/**
 * Walk upstream from a node's input, breadth-first, looking for the first typed-in text field.
 *
 * This is why binding is sampler-anchored rather than "find a CLIPTextEncode holding a literal": in
 * two of the workflows on this server the *positive* encoder's text arrives over a link from an LLM
 * prompt-expander chain while the *negative* encoder holds the only literal (`""`). Searching for
 * literals binds the negative prompt and silently regenerates the workflow author's prompt forever.
 */
function findTextInput(
  graph: ComfyGraph,
  schemas: SchemaMap,
  start: ComfyLink | undefined,
): WorkflowBinding | null {
  if (!start) return null;
  const queue: string[] = [start[0]];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = graph[nodeId];
    if (!node) continue;

    const schema = schemas.get(node.class_type) ?? null;
    for (const candidate of PROMPT_INPUTS) {
      if (!(candidate in node.inputs)) continue;
      const spec = specFor(schema, candidate);
      // Accept the input whether it currently holds a literal or a link: writing a literal over a
      // link is legal API format and simply prunes the dead upstream chain.
      if (!spec || spec.type === 'STRING') {
        return {
          node_id: nodeId,
          input: candidate,
          spec: spec ?? { type: 'STRING' },
          overrides_link: isLink(node.inputs[candidate]),
        };
      }
    }

    for (const value of Object.values(node.inputs)) {
      if (isLink(value)) queue.push(value[0]);
    }
  }
  return null;
}

/** First node whose class matches, in graph order. */
function findNode(graph: ComfyGraph, pattern: RegExp): string | null {
  return sortedNodeIds(graph).find((id) => pattern.test(graph[id]?.class_type ?? '')) ?? null;
}

/** Bind `input` on `nodeId` if the node declares it. */
function bindInput(
  graph: ComfyGraph,
  schemas: SchemaMap,
  nodeId: string,
  input: string,
): WorkflowBinding | null {
  const node = graph[nodeId];
  if (!node || !(input in node.inputs)) return null;
  const spec = specFor(schemas.get(node.class_type) ?? null, input);
  return {
    node_id: nodeId,
    input,
    ...(spec ? { spec } : {}),
    overrides_link: isLink(node.inputs[input]),
  };
}

/**
 * A multiline STRING input holding a literal — the text slot of a graph that has no sampler and no
 * conditioning chain to anchor on (a text-to-speech workflow is the motivating case).
 *
 * Restricted to *multiline* fields holding a literal, because that is what a human-authored line of
 * text looks like: single-line strings in these graphs are filenames, model names and prefixes.
 */
function findMultilineText(graph: ComfyGraph, schemas: SchemaMap): WorkflowBinding | null {
  for (const nodeId of sortedNodeIds(graph)) {
    const node = graph[nodeId]!;
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value) || typeof value !== 'string') continue;
      const spec = specFor(schemas.get(node.class_type) ?? null, input);
      if (spec?.type !== 'STRING' || !spec.multiline) continue;
      return { node_id: nodeId, input, spec, overrides_link: false };
    }
  }
  return null;
}

/** Search the whole graph for an input by name, preferring one that holds a literal. */
function findInputAnywhere(
  graph: ComfyGraph,
  schemas: SchemaMap,
  names: string[],
  wantNumeric = false,
): WorkflowBinding | null {
  let linked: WorkflowBinding | null = null;
  for (const nodeId of sortedNodeIds(graph)) {
    const node = graph[nodeId]!;
    for (const name of names) {
      if (!(name in node.inputs)) continue;
      const value = node.inputs[name];
      if (wantNumeric && !isLink(value) && typeof value !== 'number') continue;
      const binding = bindInput(graph, schemas, nodeId, name);
      if (!binding) continue;
      if (!binding.overrides_link) return binding;
      linked ??= binding;
    }
  }
  return linked;
}

/**
 * Infer which graph inputs correspond to the tool-level parameters.
 *
 * Every binding is a *guess* the operator can correct on the Media page — the auto-binder exists so
 * importing a workflow is one click, not so it is infallible. The one guess that must never be wrong
 * is `prompt`, which is why it is anchored to the sampler's positive conditioning; a wrong prompt
 * binding produces plausible images that ignore the agent entirely.
 */
export function autoBind(
  graph: ComfyGraph,
  outputsToExecute: string[],
  schemas: SchemaMap,
): AutoBindResult {
  const bindings: WorkflowBindings = {};

  const outputNodeId = pickOutputNode(graph, outputsToExecute, schemas);
  const outputKind = outputKindOf(graph[outputNodeId]?.class_type ?? '');

  // --- prompt / negative prompt, anchored on the sampler's conditioning ---
  const samplerId = findNode(graph, SAMPLER_CLASS);
  const sampler = samplerId ? graph[samplerId] : null;

  let positiveLink = sampler && isLink(sampler.inputs.positive) ? sampler.inputs.positive : undefined;
  const negativeLink = sampler && isLink(sampler.inputs.negative) ? sampler.inputs.negative : undefined;

  // SamplerCustomAdvanced routes conditioning through a guider instead of positive/negative.
  if (!positiveLink && sampler && isLink(sampler.inputs.guider)) {
    const guider = graph[sampler.inputs.guider[0]];
    if (guider && isLink(guider.inputs.conditioning)) positiveLink = guider.inputs.conditioning;
  }

  const prompt = findTextInput(graph, schemas, positiveLink);
  if (prompt) bindings.prompt = prompt;
  else {
    // No sampler (or no conditioning chain): fall back to any multiline text field named `prompt`,
    // which is how the video model's own node exposes it.
    const direct = findInputAnywhere(graph, schemas, ['prompt']);
    // Last resort: a multiline string primitive. A text-to-speech graph has no sampler, no
    // conditioning and nothing called `prompt` — the line to speak simply sits in a
    // `PrimitiveStringMultiline`. Without this the workflow imports with no prompt binding at all,
    // and every tool that selects it refuses to run rather than speak the author's test sentence.
    bindings.prompt = direct ?? findMultilineText(graph, schemas) ?? undefined;
    if (!bindings.prompt) delete bindings.prompt;
  }

  const negative = findTextInput(graph, schemas, negativeLink);
  // A zeroed-out negative isn't a prompt slot, and pointing both at one node would make the tool
  // overwrite its own prompt.
  if (
    negative &&
    negative.node_id !== bindings.prompt?.node_id &&
    !/ConditioningZeroOut/.test(graph[negative.node_id]?.class_type ?? '')
  ) {
    bindings.negative_prompt = negative;
  }

  // --- seed. `noise_seed` first: SamplerCustomAdvanced graphs keep it on RandomNoise, not the sampler.
  const seed = findInputAnywhere(graph, schemas, ['noise_seed', 'seed'], true);
  if (seed) bindings.seed = seed;

  // --- dimensions, preferring the latent that actually sizes the canvas ---
  const latentId = findNode(graph, EMPTY_LATENT_CLASS);
  const width = (latentId && bindInput(graph, schemas, latentId, 'width')) ||
    findInputAnywhere(graph, schemas, ['width'], true);
  const height = (latentId && bindInput(graph, schemas, latentId, 'height')) ||
    findInputAnywhere(graph, schemas, ['height'], true);
  if (width) bindings.width = width;
  if (height) bindings.height = height;

  const length = findInputAnywhere(graph, schemas, ['length', 'num_frames', 'frames'], true);
  if (length) bindings.length = length;
  const seconds = findInputAnywhere(graph, schemas, ['seconds'], true);
  if (seconds) bindings.seconds = seconds;
  const fps = findInputAnywhere(graph, schemas, ['fps'], true);
  if (fps) bindings.fps = fps;
  const batch = findInputAnywhere(graph, schemas, ['batch_size'], true);
  if (batch) bindings.batch = batch;

  // --- input images: every LoadImage, in graph order, becomes image1..image3 ---
  const loaders = sortedNodeIds(graph).filter((id) => graph[id]?.class_type === 'LoadImage');
  const imageKeys: BindingKey[] = ['image1', 'image2', 'image3'];
  loaders.slice(0, imageKeys.length).forEach((nodeId, i) => {
    const binding = bindInput(graph, schemas, nodeId, 'image');
    if (binding) bindings[imageKeys[i]!] = binding;
  });

  // --- input audio: same idea, from LoadAudio. A video model that takes a soundtrack paces its
  //     motion to it, so this is a driving input, not decoration.
  const audioLoaders = sortedNodeIds(graph).filter((id) => graph[id]?.class_type === 'LoadAudio');
  const audioKeys: BindingKey[] = ['audio1', 'audio2'];
  audioLoaders.slice(0, audioKeys.length).forEach((nodeId, i) => {
    const binding = bindInput(graph, schemas, nodeId, 'audio');
    if (binding) bindings[audioKeys[i]!] = binding;
  });

  // --- input video, for a video→video graph. VideoHelperSuite's loader is as common as the core
  //     one and names its input `video` too, so both are matched on class and the input by name.
  const videoLoader = findNode(graph, VIDEO_LOAD_CLASS);
  if (videoLoader) {
    const binding =
      bindInput(graph, schemas, videoLoader, 'video') ?? bindInput(graph, schemas, videoLoader, 'file');
    if (binding) bindings.video1 = binding;
  }

  const prefix = bindInput(graph, schemas, outputNodeId, 'filename_prefix');
  if (prefix) bindings.filename_prefix = prefix;

  const kind: WorkflowKind =
    outputKind === 'video' ? 'video' : outputKind === 'audio' ? 'audio' : loaders.length > 0 ? 'edit' : 'image';

  const relevant = relevantKeys(kind);
  const unbound = relevant.filter((k) => !bindings[k]);

  return { bindings, output_node_id: outputNodeId, output_kind: outputKind, kind, unbound };
}

/**
 * The weight files a graph loads, most significant loader first.
 *
 * This is the most legible answer to "what is actually running" — far more so than the node count or
 * the workflow's name — so it feeds both the discovery list and the live tool card.
 */
export function modelFiles(graph: ComfyGraph): string[] {
  const priority = ['UNETLoader', 'CheckpointLoaderSimple', 'CheckpointLoader', 'DiffusersLoader'];
  const found: { file: string; rank: number }[] = [];
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs)) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value)) continue;
      const rank = priority.indexOf(node.class_type);
      found.push({ file: value, rank: rank === -1 ? priority.length : rank });
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  return [...new Set(found.map((f) => f.file))];
}

/** Which parameters are worth reporting as missing, per workflow kind. */
export function relevantKeys(kind: WorkflowKind): BindingKey[] {
  switch (kind) {
    case 'video':
      return ['prompt', 'seed', 'width', 'height', 'length', 'fps'];
    case 'audio':
      return ['prompt', 'seed', 'seconds'];
    case 'edit':
      return ['prompt', 'seed', 'image1'];
    default:
      return ['prompt', 'negative_prompt', 'seed', 'width', 'height', 'batch'];
  }
}

// ---------------------------------------------------------------------------
// Hashing, validation, application
// ---------------------------------------------------------------------------

/**
 * Identity of a workflow as a *shape*: node classes, how they're wired, and which model files they
 * load — ignoring every typed-in scalar.
 *
 * This is what the discovery list groups by, because "the same workflow" to an operator means the
 * same graph, not the same prompt/steps/seed. Hashing literals instead would show five z-image
 * candidates that differ only in step count. Enum-valued strings (checkpoints, LoRAs, samplers) are
 * kept: swapping the model genuinely makes it a different workflow.
 */
export function structureHash(graph: ComfyGraph, schemas: SchemaMap): string {
  const ids = sortedNodeIds(graph);

  /** How one input contributes to a node's signature, given the current labels of its neighbours. */
  const inputToken = (nodeId: string, name: string, labels: Record<string, string>): string => {
    const node = graph[nodeId]!;
    const value = node.inputs[name];
    if (isLink(value)) return `${name}<-${labels[value[0]] ?? '?'}:${value[1]}`;
    const declared = schemaInputs(schemas.get(node.class_type) ?? null);
    const spec = parseInputSpec(declared[name]);
    // Which *weights* a graph loads is part of its identity — swap the checkpoint and it is a
    // different workflow. Every other dropdown (sampler, scheduler, aspect ratio, output codec) is a
    // setting the operator tweaks between runs, so it must not fork the workflow into two entries.
    if (spec?.type === 'ENUM' && typeof value === 'string' && MODEL_FILE.test(value)) {
      return `${name}=${value}`;
    }
    return `${name}:${typeof value}`;
  };

  // Weisfeiler-Leman refinement: start from class names, then twice fold in each node's neighbours'
  // labels. The point is to make the hash independent of the *node ids*, because ComfyUI renumbers
  // them whenever a subgraph is re-instantiated — the same workflow run in two sessions comes back
  // as `105:104` here and `68:104` there, and hashing ids would list it twice.
  /**
   * Only inputs the node class actually declares. ComfyUI's editor sometimes leaves UI-only leftovers
   * in a submitted graph (`SaveVideo.video-preview: ""`), and one run carrying it while another
   * doesn't must not make them look like two different workflows.
   */
  const hashableInputs = (id: string): string[] => {
    const node = graph[id]!;
    const declared = schemaInputs(schemas.get(node.class_type) ?? null);
    const names = Object.keys(node.inputs);
    const known = Object.keys(declared).length > 0 ? names.filter((n) => n in declared) : names;
    return known.sort();
  };

  let labels: Record<string, string> = Object.fromEntries(ids.map((id) => [id, graph[id]!.class_type]));
  for (let round = 0; round < 2; round += 1) {
    const next: Record<string, string> = {};
    for (const id of ids) {
      const tokens = hashableInputs(id).map((name) => inputToken(id, name, labels));
      next[id] = createHash('sha1').update(`${labels[id]}|${tokens.join(',')}`).digest('hex').slice(0, 16);
    }
    labels = next;
  }

  const canonical = ids.map((id) => labels[id]!).sort();
  return createHash('sha1').update(`${ids.length}\n${canonical.join('\n')}`).digest('hex');
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  node_id?: string;
}

/**
 * Check a stored workflow still matches the ComfyUI it will run on: every node class exists, every
 * binding points at a real input, and every model file it names is installed. Run before submitting,
 * so a missing checkpoint fails in milliseconds instead of after a ten-minute queue wait.
 *
 * Only conditions that genuinely stop the graph running are `error`. Being over-strict here is worse
 * than being lax: a false positive refuses a workflow ComfyUI would have executed perfectly, and the
 * operator has no way to overrule it.
 */
export function validateWorkflow(
  graph: ComfyGraph,
  bindings: WorkflowBindings,
  schemas: SchemaMap,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const boundInputs = new Set(
    Object.values(bindings).map((b) => `${b.node_id} ${b.input}`),
  );

  for (const nodeId of sortedNodeIds(graph)) {
    const node = graph[nodeId]!;
    const schema = schemas.get(node.class_type);
    if (schema === null || schema === undefined) {
      issues.push({
        level: 'error',
        node_id: nodeId,
        message: `Node ${nodeId} uses "${node.class_type}", which this ComfyUI doesn't have (a custom node pack may be missing).`,
      });
      continue;
    }
    const declared = schemaInputs(schema);
    for (const [input, value] of Object.entries(node.inputs)) {
      if (isLink(value) || typeof value !== 'string') continue;
      // A bound input is overwritten at submit, so whatever the workflow was saved with is about to
      // be replaced — validating the stale literal would block a run over a value never used.
      if (boundInputs.has(`${nodeId} ${input}`)) continue;
      const spec = parseInputSpec(declared[input]);
      if (!spec || spec.type !== 'ENUM' || !spec.options || spec.options.length === 0) continue;
      if (spec.options.includes(value)) continue;
      // `name [output]` is ComfyUI's *annotated filepath*: a file in the output/temp folder rather
      // than the input folder the enum lists. `LoadImage` resolves these itself, so they are valid
      // by construction and simply can never appear in the enum.
      if (ANNOTATED_FILEPATH.test(value)) continue;

      const shown = spec.options.slice(0, 6).join(', ');
      // Only weights are worth refusing to run over. Every other enum is a list of things the server
      // discovers at runtime — image files come and go, and a stale name there is not a broken graph.
      const isWeight = MODEL_FILE.test(value);
      issues.push({
        level: isWeight ? 'error' : 'warning',
        node_id: nodeId,
        message: isWeight
          ? `Node ${nodeId} (${node.class_type}) wants "${value}" for ${input}, which isn't installed. ` +
            `Available: ${shown}${spec.options.length > 6 ? ', …' : ''}`
          : `Node ${nodeId} (${node.class_type}) refers to "${value}" for ${input}, which this ComfyUI ` +
            `doesn't currently list. Available: ${shown}${spec.options.length > 6 ? ', …' : ''}`,
      });
    }
  }

  for (const [key, binding] of Object.entries(bindings) as [BindingKey, WorkflowBinding][]) {
    const node = graph[binding.node_id];
    if (!node) {
      issues.push({
        level: 'error',
        message: `The "${key}" binding points at node ${binding.node_id}, which isn't in this workflow.`,
      });
      continue;
    }
    const declared = schemaInputs(schemas.get(node.class_type) ?? null);
    if (Object.keys(declared).length > 0 && !(binding.input in declared)) {
      issues.push({
        level: 'error',
        node_id: binding.node_id,
        message: `The "${key}" binding points at input "${binding.input}", which ${node.class_type} doesn't have.`,
      });
    }
  }

  return issues;
}

/** Clamp a number to the input's declared range and value grid. */
export function clampToSpec(value: number, spec?: ComfyInputSpec): number {
  if (!spec) return value;
  let out = value;
  if (typeof spec.min === 'number') out = Math.max(spec.min, out);
  if (typeof spec.max === 'number') out = Math.min(spec.max, out);
  // A step > 1 is a real constraint, not cosmetics: MiniMax H3's `length` declares `step: 17` because
  // the model only accepts frame counts on a 17k+5 grid.
  if (typeof spec.step === 'number' && spec.step > 1) {
    const base = typeof spec.min === 'number' ? spec.min : 0;
    out = base + Math.round((out - base) / spec.step) * spec.step;
    if (typeof spec.min === 'number') out = Math.max(spec.min, out);
    if (typeof spec.max === 'number') out = Math.min(spec.max, out);
  }
  if (spec.type === 'INT') out = Math.round(out);
  return out;
}

export type BindingValues = Partial<Record<BindingKey, string | number>>;

/**
 * Produce a submittable graph with the caller's values written into the bound inputs. The original is
 * never mutated — a stored workflow is a template, and one run must not leak into the next.
 */
export function applyBindings(
  graph: ComfyGraph,
  bindings: WorkflowBindings,
  values: BindingValues,
): ComfyGraph {
  const clone = structuredClone(graph) as ComfyGraph;
  for (const [key, value] of Object.entries(values) as [BindingKey, string | number | undefined][]) {
    if (value === undefined || value === null || value === '') continue;
    const binding = bindings[key];
    if (!binding) continue;
    const node = clone[binding.node_id];
    if (!node) continue;
    node.inputs[binding.input] =
      typeof value === 'number' ? clampToSpec(value, binding.spec) : value;
  }
  return clone;
}

/** Per-node summary for the binding editor: what can be bound, and what it currently holds. */
export interface NodeDescription {
  id: string;
  class_type: string;
  title: string;
  inputs: {
    name: string;
    type: ComfyInputSpec['type'];
    is_link: boolean;
    value: string | number | boolean | null;
    options?: string[];
  }[];
}

export function describeNodes(graph: ComfyGraph, schemas: SchemaMap): NodeDescription[] {
  return sortedNodeIds(graph).map((id) => {
    const node = graph[id]!;
    const declared = schemaInputs(schemas.get(node.class_type) ?? null);
    const names = [...new Set([...Object.keys(node.inputs), ...Object.keys(declared)])];
    return {
      id,
      class_type: node.class_type,
      title: node._meta?.title || node.class_type,
      inputs: names.map((name) => {
        const spec = parseInputSpec(declared[name]);
        const raw = node.inputs[name];
        const link = isLink(raw);
        return {
          name,
          type: spec?.type ?? 'LINK',
          is_link: link,
          value: link || raw === undefined ? null : (raw as string | number | boolean | null),
          ...(spec?.options ? { options: spec.options } : {}),
        };
      }),
    };
  });
}
