import type { ImageBlock } from '../core/event-bus/events.types';
import type { AgentExecutor } from '../isolation/AgentContainerManager';

/** Runtime context handed to every tool/skill invocation. */
export interface ToolContext {
  sessionId: string;
  agentId: string;
  agentName: string;
  /** Hop depth of the invoking agent (0 = directly addressed). */
  depth: number;
  /**
   * Cross-agent dispatcher, injected by the orchestrator. Present only when the current
   * run is allowed to spawn sub-agents (the hop guard may withhold it at max depth).
   * Returns the sub-agent's final `text` answer plus any `images` it acquired during its turn and is
   * handing back to the caller (pictures flow both ways). `images` arg (optional) forwards attachments
   * *down* to the sub-agent's turn (e.g. hand a user-dropped image to a vision specialist). Kept as an
   * inline structural type so the tool layer never imports the AgentRunner (avoids a dependency cycle).
   */
  invokeSubAgent?: (
    targetAgentName: string,
    query: string,
    images?: ImageBlock[],
  ) => Promise<{ text: string; images?: ImageBlock[] }>;
  /**
   * Back-channel to the agent that delegated this run (present only on a delegated sub-agent run
   * while a hop remains). Re-runs the caller as an inference turn — seeded with the caller's
   * original conversation — so it can answer a clarifying question. Returns the caller's answer.
   */
  askParent?: (question: string) => Promise<string>;
  /**
   * Ask the human operator a question and block until they reply in the UI (opencode-style).
   * Available to every agent regardless of depth. Rejects on timeout or if the session ends.
   */
  askUser?: (question: string) => Promise<string>;
  /** LLM tool-call id for this invocation (correlates streamed output to the block). */
  callId?: string;
  /** Emit incremental output while running (e.g. bash stdout) for live streaming to the UI. */
  emitOutput?: (chunk: string) => void;
  /**
   * Present only when the running agent has isolation enabled: an executor bound to the agent's
   * dedicated container. `bash` and skills run through it instead of on the backend. Absent for
   * non-isolated agents (execution stays in the backend container, as before).
   */
  exec?: AgentExecutor;
  /**
   * Set when isolation is enabled but the agent's container couldn't be made ready (e.g. image not
   * built). Linux-execution tools (`bash`, skills) must return this as an error rather than falling
   * back to the backend — the isolation guarantee is strict.
   */
  isolationError?: string;
  /**
   * Emit a vision-analysis panel to the UI (screenshot thumbnail + the question + the vision model's
   * answer) for the current tool call. Used by `visual_screenshot` so the operator sees what the
   * vision model saw and said, without folding the raw image into the (text-only) agent's context.
   */
  emitVision?: (payload: {
    image: string;
    question: string;
    answer: string;
    model: string;
    /** Located pixel + its coordinate space (localize mode) so the UI marks it on the preview. */
    x?: number | null;
    y?: number | null;
    width?: number;
    height?: number;
    /** Set when the located point was snapped to an OCR text box, so the UI shows an "OCR" chip. */
    snap?: { text: string; x: number; y: number } | null;
  }) => void;
  /**
   * Emit an action-marker panel to the UI for the current tool call: a screenshot thumbnail plus the
   * pixel where `visual_act` acted (and, for drags, the destination). Lets the operator see *where* an
   * action landed, both as an inline card and as a transient pulse on the live desktop.
   */
  emitVisualAct?: (payload: {
    image: string;
    width: number;
    height: number;
    action: string;
    x: number | null;
    y: number | null;
    x2?: number | null;
    y2?: number | null;
    /** Set when the click target was snapped to an OCR text box (visual_click), for the "OCR" chip. */
    snap?: { text: string; x: number; y: number } | null;
  }) => void;
  /**
   * Emit a generation card to the UI for the current tool call: the prompt + effective sampling params
   * + model. Used by `generate_image` so the operator sees what was asked for; the image pixels flow
   * separately as tool-result images (pooled/persisted), so they aren't sent twice.
   */
  emitImageGen?: (payload: {
    prompt: string;
    size: string;
    n: number;
    steps: number;
    guidance: number;
    seed: number | null;
    negativePrompt: string | null;
    model: string;
    count: number;
  }) => void;
  /**
   * The turn's live image pool (data URLs, each with a stable `id` handle): the user/parent
   * attachments plus any images tools/skills have acquired so far this turn (e.g. a picture read via
   * `read`). Available to `analyze_image` (describe one by `image_id`) and forwardable to a subagent
   * via `ask_agent` (by `image_ids`, or all of them). A multimodal agent also receives images
   * directly in its context; a text-only agent only reaches them through these tools — always by
   * handle, never by filesystem path.
   */
  attachedImages?: ImageBlock[];
  /**
   * The tools this agent can call this turn (name + description + JSON-schema parameters), as resolved
   * by the orchestrator. Lets the `guide` tool scope its index to what the agent actually has and
   * auto-generate a guide for any tool that lacks a curated one.
   */
  availableTools?: { name: string; description: string; parameters: unknown }[];
}

export interface ToolResult {
  /** Structured payload fed back into the inference loop (stringified for the model). */
  result: unknown;
  /** Base64 images the tool produced, appended to context by the JIT builder. */
  images?: ImageBlock[];
  /**
   * Opaque binary blob resources the tool produced (e.g. `webfetch` on a PDF). Unlike `images`, blobs
   * never enter the model's context — the runner persists them and hands the agent a `blob_N` handle
   * to save (`write` from_handle) or forward. A blob block should carry `kind: 'blob'` and, when the
   * producing tool already persisted the bytes, a `storageId` (so the runner won't re-store them).
   */
  resources?: ImageBlock[];
}

/**
 * A single operator-tunable option a tool exposes on the Tools page. Distinct from `parameters`
 * (which the LLM fills per call) — these are persisted config the operator sets once.
 */
export interface ToolConfigField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'number' | 'boolean' | 'select';
  /** Allowed values when `type` is `'select'`. */
  options?: string[];
  hint?: string;
  default: string | number | boolean;
}

/** A callable tool exposed to an agent — either a static core tool or a wrapped dynamic skill. */
export interface Tool {
  name: string;
  description: string;
  /** JSON schema for the tool's arguments (surfaced to the LLM). */
  parameters: Record<string, unknown>;
  /**
   * Optional operator-tunable options, rendered on the Tools page and persisted per tool.
   * A tool reads its effective values at run time via `toolConfigService.resolve`.
   */
  configSchema?: ToolConfigField[];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
