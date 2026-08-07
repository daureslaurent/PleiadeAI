import { BINDING_KEYS, type BindingKey, type WorkflowKind } from './media-workflow.model';
import { relevantKeys } from '../../media/comfy/graph-introspect';

/**
 * The app half of a binding, described well enough to draw.
 *
 * The Media page's mapping canvas puts a port on the "App inputs" node for each of these, so an
 * operator wiring `prompt → CLIPTextEncode.text` can see what will arrive down that wire and which
 * setting on the Tools/Flows page decides it. Previously the app half was a bare key name and the
 * answer to "where does this value come from?" existed only in the tool source.
 */
export interface BindingMeta {
  key: BindingKey;
  label: string;
  /** Port colour class, shared with the Flows canvas palette; `number` is media-only. */
  port: 'text' | 'number' | 'image' | 'audio' | 'video';
  /** What the value *is*. */
  description: string;
  /** Where it comes from at run time — the tool config field or flow port that fills it. */
  source: string;
  /** Workflow kinds this parameter is meaningful for; empty means "all of them". */
  kinds: WorkflowKind[];
  /** True when a workflow of a matching kind is expected to expose it (drives the unbound warning). */
  expected: boolean;
}

const ALL: WorkflowKind[] = [];
const VIDEOISH: WorkflowKind[] = ['video', 'video_edit'];

/** Exported so tool schema builders (`tools/core/media-schema.ts`) can reuse the same label/description text. */
export const META: Record<BindingKey, Omit<BindingMeta, 'key' | 'expected'>> = {
  prompt: {
    label: 'prompt',
    port: 'text',
    description: 'The positive text prompt — what to make.',
    source: "The tool call's `prompt`, or the flow node's Prompt field plus its prompt port.",
    kinds: ALL,
  },
  negative_prompt: {
    label: 'negative prompt',
    port: 'text',
    description: 'What to avoid. Only graphs with a real negative encoder can use it.',
    source: 'The Negative prompt setting on the tool or flow node.',
    kinds: ['image', 'edit', 'audio'],
  },
  seed: {
    label: 'seed',
    port: 'number',
    description: 'Noise seed. Left unbound, every run repeats ComfyUI\'s own fixed seed.',
    source: 'Random per run, unless the flow node pins it with Seed = fixed.',
    kinds: ALL,
  },
  width: {
    label: 'width',
    port: 'number',
    description: 'Output width in pixels, clamped to the input\'s step grid.',
    source: 'The Size setting; for image-to-video, derived from the input picture.',
    kinds: ['image', 'video', 'edit', 'video_edit'],
  },
  height: {
    label: 'height',
    port: 'number',
    description: 'Output height in pixels, clamped to the input\'s step grid.',
    source: 'The Size setting; for image-to-video, derived from the input picture.',
    kinds: ['image', 'video', 'edit', 'video_edit'],
  },
  length: {
    label: 'frames',
    port: 'number',
    description: 'Frame count. Many models only accept a grid of values (MiniMax H3: 17k+5).',
    source: 'Duration × FPS on the tool or flow node.',
    kinds: VIDEOISH,
  },
  seconds: {
    label: 'seconds',
    port: 'number',
    description: 'Clip length in seconds, for a graph that thinks in time rather than frames.',
    source: 'The Duration setting.',
    kinds: ['audio', 'video'],
  },
  fps: {
    label: 'fps',
    port: 'number',
    description: 'Frame rate of the rendered clip.',
    source: 'The FPS setting.',
    kinds: VIDEOISH,
  },
  batch: {
    label: 'batch',
    port: 'number',
    description: 'How many results one run produces.',
    source: 'The Count setting.',
    kinds: ['image', 'edit'],
  },
  image1: {
    label: 'image 1',
    port: 'image',
    description: 'First source image, uploaded to ComfyUI and named on a LoadImage node.',
    source: "The tool's `image` argument, or the flow node's image port.",
    kinds: ['edit', 'video', 'video_edit'],
  },
  image2: {
    label: 'image 2',
    port: 'image',
    description: 'Second source image, for a graph that composes or blends two.',
    source: 'The second handle wired into the node\'s image port.',
    kinds: ['edit', 'video'],
  },
  image3: {
    label: 'image 3',
    port: 'image',
    description: 'Third source image.',
    source: 'The third handle wired into the node\'s image port.',
    kinds: ['edit', 'video'],
  },
  audio1: {
    label: 'audio 1',
    port: 'audio',
    description: 'Reference sound an A/V model paces and lip-syncs its motion to.',
    source: "The flow node's audio port.",
    kinds: VIDEOISH,
  },
  audio2: {
    label: 'audio 2',
    port: 'audio',
    description: 'Second reference sound.',
    source: "The flow node's audio port (second handle).",
    kinds: VIDEOISH,
  },
  video1: {
    label: 'video',
    port: 'video',
    description: 'Source clip for a video→video graph, named on a LoadVideo node.',
    source: "The flow node's video port (Edit Video requires it).",
    kinds: ['video_edit', 'video'],
  },
  filename_prefix: {
    label: 'filename prefix',
    port: 'text',
    description: "Where ComfyUI writes the result inside its output folder.",
    source: 'Set automatically to `pleiades/<kind>/<workflow>`.',
    kinds: ALL,
  },
};

/** The full catalog, with `expected` resolved for one workflow kind. */
export function bindingCatalog(kind?: WorkflowKind): BindingMeta[] {
  const expected = new Set<BindingKey>(kind ? relevantKeys(kind) : []);
  return BINDING_KEYS.map((key) => ({
    key,
    ...META[key],
    expected: expected.has(key),
  }));
}
