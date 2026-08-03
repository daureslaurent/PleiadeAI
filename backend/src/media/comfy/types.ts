/**
 * Wire shapes of the ComfyUI HTTP/WS API (verified against ComfyUI 0.30.0).
 *
 * ComfyUI speaks *API-format* workflow graphs: a flat `{ [nodeId]: { class_type, inputs, _meta } }`
 * map where an input value is either a literal or a `[sourceNodeId, outputSlot]` link. This is NOT
 * the `.json` the UI saves — that one is the editor's own format (positions, link ids, subgraph
 * definitions) and would have to be flattened by the frontend's graph engine to become submittable.
 * See `discovery.service.ts` for why we read API graphs out of `/history` instead.
 */

/** `[sourceNodeId, outputSlotIndex]` — an input fed by another node's output. */
export type ComfyLink = [string, number];

export type ComfyInputValue = string | number | boolean | null | ComfyLink | unknown;

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, ComfyInputValue>;
  /** Editor metadata. `_meta.title` is the operator's label for the node — good for progress lines. */
  _meta?: { title?: string };
}

/** An API-format workflow: node id → node. */
export type ComfyGraph = Record<string, ComfyNode>;

/** A file produced (or consumed) by ComfyUI, as it appears in `outputs` and `/upload/image`. */
export interface ComfyFileRef {
  filename: string;
  subfolder: string;
  /** `output` for generated files, `input` for uploads, `temp` for previews. */
  type: string;
}

/**
 * A node's `ui` outputs in a history entry. The keys are node-defined and NOT reliable indicators of
 * media type — `SaveVideo` publishes its mp4 under `images` (verified). Always classify by extension.
 */
export type ComfyNodeOutputs = Record<string, unknown> & {
  images?: ComfyFileRef[];
  gifs?: ComfyFileRef[];
  audio?: ComfyFileRef[];
  video?: ComfyFileRef[];
  animated?: boolean[];
};

/** One `status.messages` entry: `[eventName, payload]`. */
export type ComfyStatusMessage = [string, Record<string, unknown>];

export interface ComfyHistoryEntry {
  /**
   * `[queueNumber, promptId, graph, extraData, outputsToExecute]`. Index 2 is the **API-format
   * graph** — already flattened, directly re-submittable. Index 4 lists the output node ids.
   */
  prompt: [number, string, ComfyGraph, Record<string, unknown>, string[]];
  outputs: Record<string, ComfyNodeOutputs>;
  status?: {
    status_str: 'success' | 'error' | string;
    completed: boolean;
    messages: ComfyStatusMessage[];
  };
}

export type ComfyHistory = Record<string, ComfyHistoryEntry>;

export interface ComfySystemStats {
  system: {
    os: string;
    ram_total: number;
    ram_free: number;
    comfyui_version: string;
    python_version: string;
    argv?: string[];
  };
  devices: {
    name: string;
    type: string;
    index: number | null;
    vram_total: number;
    vram_free: number;
  }[];
}

export interface ComfyQueueInfo {
  /** Entries are `[queueNumber, promptId, graph, extraData, outputsToExecute]` — same shape as history. */
  queue_running: unknown[][];
  queue_pending: unknown[][];
}

/** A single node class's schema from `/object_info/<ClassName>`. */
export interface ComfyNodeSchema {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output?: string[];
  output_name?: string[];
  output_node?: boolean;
  category?: string;
  display_name?: string;
}

/**
 * The constraints we lift out of a node schema for one input, used to clamp values and to hint the
 * binding editor. `options` is the enum list (installed model files, sampler names…).
 */
export interface ComfyInputSpec {
  type: 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'ENUM' | 'LINK';
  min?: number;
  max?: number;
  /** Value granularity. MiniMax H3's `length` declares `step: 17` — the 17k+5 frame grid. */
  step?: number;
  default?: string | number | boolean;
  multiline?: boolean;
  options?: string[];
  tooltip?: string;
}

/** `POST /prompt` response. */
export interface ComfySubmitResult {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, unknown>;
}

/** `POST /upload/image` response. */
export interface ComfyUploadResult {
  name: string;
  subfolder: string;
  type: string;
}
