/**
 * Mirror of the backend WebSocket payload schema (§6 of IMPLEMENTATION_PLAN.md).
 * Keep in lockstep with `backend/src/transport/ws/bridge.ts`.
 */
export interface StreamChunkEvent {
  type: 'stream_chunk';
  agent: string;
  content: string;
  is_reasoning: boolean;
}

export interface AgentHopEvent {
  type: 'agent_hop';
  from: string;
  to: string;
  depth: number;
  query: string;
  /** The invoked sub-agent's run id — tags its bubble so its own quality score can attach. */
  childRunId: string;
}

export interface AgentHopDoneEvent {
  type: 'agent_hop_done';
  from: string;
  to: string;
  depth: number;
  status: 'success' | 'error';
}

export interface ToolStartEvent {
  type: 'tool_start';
  agent: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolOutputEvent {
  type: 'tool_output';
  callId: string;
  chunk: string;
}

export interface ToolEndEvent {
  type: 'tool_end';
  agent: string;
  callId: string;
  tool: string;
  status: 'success' | 'error';
  result: unknown;
  /** Images the tool acquired into the turn (e.g. a picture read via `read`), keyed by handle. */
  images?: { id?: string; dataUrl: string }[];
}

export interface SystemAlertEvent {
  type: 'system_alert';
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Vision analysis of a `visual_screenshot` call: the screenshot thumbnail + the model's answer. */
export interface VisionEvent {
  type: 'vision';
  callId: string;
  /** Small JPEG thumbnail (data URL) of the analysed screenshot. */
  image: string;
  /** The question the agent asked about the screen (empty → general description). */
  question: string;
  /** The vision model's textual answer (or a config hint when no vision endpoint is set). */
  answer: string;
  /** The vision model id (empty when unavailable). */
  model: string;
  /** Located pixel (localize mode) + its coordinate space, so the card marks it on the preview. */
  x?: number | null;
  y?: number | null;
  width?: number;
  height?: number;
  /** Present when the located point was snapped to an OCR text box — shows an "OCR" chip on the card. */
  snap?: { text: string; x: number; y: number } | null;
}

/**
 * A media tool produced artifact(s). Carries the prompt + the effective settings for the chat's
 * generation card; images themselves arrive on the matching `tool_end` (pooled + persisted like any
 * tool-acquired image), and video/audio are fetched by resource handle, so nothing is duplicated here.
 */
export interface MediaGenEvent {
  type: 'media_gen';
  callId: string;
  /**
   * `start` lands seconds after the remote accepts the job and names the run; `done` adds the
   * artifacts. The store merges them, so `start`-only fields stay put.
   */
  phase: 'start' | 'done';
  kind: 'image' | 'video' | 'audio';
  prompt: string;
  negativePrompt: string | null;
  /** Name of the ComfyUI workflow that ran. */
  workflow: string;
  workflowKind?: string;
  /** Weight files the workflow loads. */
  models?: string[];
  /** The remote job's id and server — together they locate the run in ComfyUI. */
  promptId?: string;
  comfyUrl?: string;
  queuePosition?: number;
  /** Free / total VRAM on the tightest GPU at submit. */
  vramFreeBytes?: number;
  vramTotalBytes?: number;
  seed: number | null;
  /** Effective generation settings, rendered as chips. */
  params: Record<string, string | number>;
  /** Number of artifacts actually returned (`done` only). */
  count?: number;
  /** Resource handles of the artifacts — how the card streams a video/audio. */
  resourceIds?: string[];
  /** `edit_image` only: handle of the source image, for the before/after pair. */
  sourceId: string | null;
}

/**
 * Live progress for a long-running tool call (a ComfyUI render). Not persisted anywhere: it describes
 * a moment, so a reloaded turn shows the finished card rather than a stale bar.
 */
export interface ToolProgressEvent {
  type: 'tool_progress';
  callId: string;
  phase: 'queued' | 'running' | 'downloading';
  percent: number | null;
  node?: string;
  nodeLabel?: string;
  /** Sampler steps within the current node, and graph nodes overall. */
  step?: number;
  steps?: number;
  nodesDone?: number;
  nodesTotal?: number;
  queuePosition?: number;
  elapsedMs: number;
  etaMs: number | null;
  /** Newest in-progress preview frame as a data URL, when the remote emits them. */
  preview?: string;
  /** Whether any preview has arrived — separates "server isn't sending them" from "not yet". */
  sawPreview?: boolean;
  message?: string;
}

/** Action marker for a `visual_act` call: a screenshot + where the action landed (drive-the-desktop). */
export interface VisualActEvent {
  type: 'visual_act';
  callId: string;
  /** The agent whose desktop was acted on — lets the live desktop panel filter to its own agent. */
  agentId: string;
  /** Screenshot thumbnail (data URL) the marker is drawn over. */
  image: string;
  /** Coordinate space of the marker = the desktop screen size in pixels. */
  width: number;
  height: number;
  /** Canonical action performed (click, drag, type, …). */
  action: string;
  /** Primary marker point in screen pixels (drag start / click / final cursor). */
  x: number | null;
  y: number | null;
  /** Drag destination in screen pixels (action=drag only). */
  x2?: number | null;
  y2?: number | null;
  /** Present when a visual_click target was snapped to an OCR text box — shows an "OCR" chip. */
  snap?: { text: string; x: number; y: number } | null;
}

/**
 * The directly-addressed agent's turn hit its tool-round cap before producing a final answer — it was
 * cut off mid-task. Lets the composer offer / auto-fire a "continue" instead of the operator having to
 * notice the stall. Only emitted for the user-facing (depth 0) run.
 */
export interface TruncatedEvent {
  type: 'truncated';
  sessionId: string;
  agent: string;
}

/** An agent is blocked asking the operator a question; the run resumes on `ask_user:response`. */
export interface AskUserEvent {
  type: 'ask_user';
  sessionId: string;
  requestId: string;
  agent: string;
  question: string;
}

/** One memory the agent auto-recalled from its vector store and injected into this run's prompt. */
export interface RecalledMemory {
  text: string;
  /**
   * Composite rerank score that won this memory its slot: similarity, recency, importance, and how
   * often it has proven useful before. Deliberately NOT the raw cosine — a memory can beat a more
   * similar one by being recent, important, or repeatedly recalled.
   */
  score: number;
  /** Raw cosine similarity to the turn's query (0–1), so the two can be compared. */
  similarity?: number;
  /** `fact` | `preference` | `procedure` | `episode`. */
  kind?: string;
  /** Short topic key the memory is filed under. */
  subject?: string;
  /** 1–5. */
  importance?: number;
  /** `distiller` (the agent's model rewrote a turn into it), `remember_tool`, or legacy `auto_turn`. */
  source?: string;
  createdAt?: string;
}

/**
 * Memories folded into an agent-run's prompt before inference — the chat's "memories" badge. Routed
 * by depth like `context_usage`: `depth === 0` belongs to the turn itself, `depth > 0` to the
 * delegated sub-agent's own bubble. Only emitted when the recall actually returned something.
 */
export interface MemoryRecallEvent {
  type: 'memory_recall';
  sessionId: string;
  agent: string;
  depth: number;
  runId: string;
  memories: RecalledMemory[];
}

/** One item of an agent's working checklist. */
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * An agent rewrote its task list (`todowrite`). Routed by depth like `memory_recall`: `depth === 0`
 * is the session agent's list (drives the pinned checklist), `depth > 0` belongs to the delegated
 * sub-agent's own bubble. Every write sends the complete list, so this replaces rather than patches.
 */
export interface TodoUpdateEvent {
  type: 'todo_update';
  sessionId: string;
  agent: string;
  agentId: string;
  depth: number;
  callId: string;
  items: TodoItem[];
}

/**
 * Context size (prompt tokens) reported after an agent run. `depth === 0` is the session's
 * user-facing agent (drives the chat header meter); `depth > 0` is a delegated sub-agent run, whose
 * usage is attributed to its own bubble.
 */
export interface ContextUsageEvent {
  type: 'context_usage';
  sessionId: string;
  agent: string;
  depth: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  /** `live` = a real-time in-turn reading (amber); `final` = the settled peak (blue total). */
  phase: 'live' | 'final';
}

/**
 * LLM Debug feed (global `llama-log` room, not session-scoped). One raw HTTP call to the inference
 * server streams as start → deltas → end. Bodies are deliberately absent — the full record is
 * fetched over REST once the call ends; these events only drive the live-at-top card.
 */
export interface LlamaCallStartEvent {
  type: 'llama_call_start';
  id: string;
  source: 'chat-turn' | 'title-gen' | 'identity' | 'vision';
  agent: string | null;
  model: string;
  endpoint: string;
  /** Outgoing request with image parts truncated to placeholders. */
  request: { model: string; messages: unknown[]; tools?: unknown[]; stream: boolean; maxTokens?: number; temperature?: number; topP?: number };
  at: number;
}

export interface LlamaCallDeltaEvent {
  type: 'llama_call_delta';
  id: string;
  delta: string;
  is_reasoning: boolean;
}

export interface LlamaCallEndEvent {
  type: 'llama_call_end';
  id: string;
  status: 'success' | 'error';
  duration_ms: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

/**
 * An agent-run was scored by the Conversation Quality Scorer (live badge on the chat + LLM Debug).
 * `runId` is the badge target — the top-level turn or a specific sub-agent bubble; `turnId` groups
 * the runs of one user turn.
 */
export interface TurnScoredEvent {
  type: 'turn_scored';
  sessionId: string | null;
  runId: string;
  turnId: string;
  agentName: string | null;
  depth: number | null;
  score: number;
  tag: 'Perfect' | 'Patched' | 'Recovered' | 'Rejected';
  explanation: string;
}

/**
 * A tracked fine-tune job advanced on its remote server (emitted by the backend poller to the
 * `finetune` room). `newMetrics` carries only the datapoints observed since the last tick — the
 * client appends them to the job's loss curve rather than replacing it.
 */
export interface FinetuneJobUpdateEvent {
  type: 'finetune_job_update';
  /** The `finetune_jobs` document id (the UI's key), not the remote job id. */
  jobId: string;
  serverId: string;
  runName: string;
  status: 'queued' | 'preparing' | 'training' | 'exporting' | 'done' | 'failed';
  progress: number;
  newMetrics: { step: number; loss: number; epoch?: number; lr?: number; at: string }[];
  ggufFilename?: string;
  error?: string;
}

// --- Flows (FLOWS_PLAN.md §5) ----------------------------------------------------------------
// A flow run's socket room is its run id, so the Flows page joins it with the ordinary
// `session:subscribe` and also receives the agent/tool/media events its nodes emit.

export interface FlowRunStartEvent {
  type: 'flow_run_start';
  runId: string;
  flowId: string;
  flowName: string;
  trigger: string;
}

export interface FlowNodeStartEvent {
  type: 'flow_node_start';
  runId: string;
  nodeId: string;
  nodeType: string;
  label: string;
  /** Set inside a `for_each` body, so repeated executions are distinguishable. */
  iteration?: number;
}

export interface FlowNodeProgressEvent {
  type: 'flow_node_progress';
  runId: string;
  nodeId: string;
  phase: 'queued' | 'running' | 'downloading';
  percent?: number | null;
  message?: string;
  /** Latest ComfyUI preview frame (data URL), when the remote emits them. */
  preview?: string;
  etaMs?: number | null;
  elapsedMs: number;
}

export interface FlowNodeOutputEvent {
  type: 'flow_node_output';
  runId: string;
  nodeId: string;
  chunk: string;
}

export interface FlowNodeEndEvent {
  type: 'flow_node_end';
  runId: string;
  nodeId: string;
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  summary?: string;
  handles?: string[];
  error?: string;
}

export interface FlowRunEndEvent {
  type: 'flow_run_end';
  runId: string;
  status: 'success' | 'error' | 'aborted';
  durationMs: number;
  output?: string;
  handles?: string[];
  error?: string;
}

/** A node persisted an artifact — emitted as the bytes land, not when the node finishes. */
export interface FlowArtifactEvent {
  type: 'flow_artifact';
  runId: string;
  nodeId: string;
  handle: string;
  kind: 'image' | 'blob';
  mime: string;
  size: number;
  filename?: string;
  iteration?: number;
}

export interface FlowAwaitingApprovalEvent {
  type: 'flow_awaiting_approval';
  runId: string;
  nodeId: string;
  question: string;
  artifacts: string[];
}

export type WsEvent =
  | StreamChunkEvent
  | AgentHopEvent
  | AgentHopDoneEvent
  | ToolStartEvent
  | ToolOutputEvent
  | ToolEndEvent
  | VisionEvent
  | MediaGenEvent
  | ToolProgressEvent
  | SystemAlertEvent
  | AskUserEvent
  | TruncatedEvent
  | ContextUsageEvent
  | MemoryRecallEvent
  | TodoUpdateEvent
  | LlamaCallStartEvent
  | LlamaCallDeltaEvent
  | LlamaCallEndEvent
  | TurnScoredEvent
  | FinetuneJobUpdateEvent
  | FlowRunStartEvent
  | FlowNodeStartEvent
  | FlowNodeProgressEvent
  | FlowNodeOutputEvent
  | FlowNodeEndEvent
  | FlowRunEndEvent
  | FlowArtifactEvent
  | FlowAwaitingApprovalEvent;
