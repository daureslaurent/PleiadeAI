/**
 * Canonical internal EventBus contract.
 *
 * These are the *backend* event payloads that flow across the in-process EventEmitter.
 * They are intentionally richer than the frontend WebSocket schema — `transport/ws/bridge.ts`
 * (Step 8) narrows/maps them down to the wire payloads in §6 of IMPLEMENTATION_PLAN.md.
 *
 * `EventMap` binds each event name to exactly one payload type, giving the TypedEventBus
 * compile-time safety with zero runtime dependency.
 */

/** Correlates every event belonging to one user turn / one agent run. */
export interface EventContext {
  /** Unique id for a single user-initiated turn (spans hops, tools, streaming). */
  sessionId: string;
  /** The agent currently producing this event. */
  agentId: string;
  agentName: string;
  /** Cross-agent hop depth for this event (0 = the directly addressed agent). */
  depth: number;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * A resource an agent can reference by handle — historically only images, now generalized to also
 * carry opaque binary **blobs** (a fetched PDF, a downloaded archive). Images (`kind: 'image'`) carry
 * a `dataUrl` and can be folded into a multimodal model's context; blobs (`kind: 'blob'`) never enter
 * context — they hold only metadata + a handle, and their bytes live in the persisted resource store
 * (GridFS). The interface name stays `ImageBlock` for backward compatibility across the codebase.
 */
export interface ImageBlock {
  /**
   * Base64 data URL, e.g. `data:image/png;base64,...` — llama.cpp multimodal input. Present for
   * images; omitted for blobs (their bytes are reached by handle via the resource store, never inlined).
   */
  dataUrl?: string;
  /**
   * Stable handle (e.g. `img_1`, `blob_1`). Agents reference a resource by this id — to analyse an
   * image (`analyze_image`), forward it (`ask_agent`), or write a blob to a file (`write from_handle`)
   * — never by filesystem path (paths don't survive a cross-agent hop). Assigned by the resource pool;
   * preserved across a hop so parent and child speak the same handle.
   */
  id?: string;
  /** How the resource entered the turn: a user/parent attachment, or acquired by a tool/skill. */
  source?: 'attachment' | 'tool';
  /** `'image'` (multimodal, has `dataUrl`) or `'blob'` (opaque bytes, reference-only). Default `'image'`. */
  kind?: 'image' | 'blob';
  /** MIME type, e.g. `application/pdf`. Mainly for blobs; images infer it from `dataUrl`. */
  mime?: string;
  /** Byte size of the resource, when known (blobs). */
  size?: number;
  /** Suggested filename for a blob (from the URL / Content-Disposition), used on download. */
  filename?: string;
  /** GridFS id of the persisted bytes, once stored. Lets a later turn/agent re-read by handle. */
  storageId?: string;
}

export interface UserMessagePayload {
  ctx: EventContext;
  content: string;
  /** Drag-and-drop or tool-acquired images attached to this message. */
  images?: ImageBlock[];
}

export interface StreamChunkPayload {
  ctx: EventContext;
  content: string;
  /** True while the chunk falls inside a `<think>` reasoning block. */
  isReasoning: boolean;
}

export interface ToolInvokePayload {
  ctx: EventContext;
  /** LLM-assigned tool call id, echoed back on completion. */
  callId: string;
  tool: string;
  /** Parsed JSON arguments the model requested. */
  args: Record<string, unknown>;
}

export type ToolStatus = 'success' | 'error';

export interface ToolCompletePayload {
  ctx: EventContext;
  callId: string;
  tool: string;
  status: ToolStatus;
  /** Structured result fed back into the inference loop (stringified for the model). */
  result: unknown;
  /** Base64 images produced by the tool, appended to context by the JIT builder. */
  images?: ImageBlock[];
  durationMs: number;
}

export interface AskAgentPayload {
  ctx: EventContext;
  from: string;
  to: string;
  /** Depth of the *invoked* agent (parent depth + 1). Guarded against MAX_AGENT_HOPS. */
  depth: number;
  query: string;
  /** The invoked sub-agent's run id — so the UI can tag its bubble and attach its own score. */
  childRunId: string;
}

export interface AskAgentDonePayload {
  ctx: EventContext;
  from: string;
  to: string;
  depth: number;
  status: 'success' | 'error';
}

export interface ToolOutputChunkPayload {
  ctx: EventContext;
  callId: string;
  /** Incremental stdout/stderr emitted by a tool (e.g. bash) while it runs. */
  chunk: string;
}

export interface VisionAnalysisPayload {
  ctx: EventContext;
  /** Correlates with the `visual_screenshot` tool call that produced it. */
  callId: string;
  /** Small JPEG thumbnail (data URL) of the screenshot the vision model analysed — display only. */
  image: string;
  /** The question the agent asked about the screen (empty → a general description was requested). */
  question: string;
  /** The vision model's textual answer (or a config hint when no vision endpoint is set). */
  answer: string;
  /** The vision model id that produced the answer (empty when unavailable). */
  model: string;
  /** Located pixel (localize mode only) so the UI can mark it on the preview. Absent for describe mode. */
  x?: number | null;
  y?: number | null;
  /** Coordinate space of `x`/`y` = the screenshot's pixel size (present when `x`/`y` are). */
  width?: number;
  height?: number;
  /** Present when the located point was snapped to an OCR text box — drives the chat "OCR" chip. */
  snap?: { text: string; x: number; y: number } | null;
}

export interface VisualActPayload {
  ctx: EventContext;
  /** Correlates with the `visual_act` tool call that produced it. */
  callId: string;
  /** Small JPEG thumbnail (data URL) of the frame the action was marked on — display only. */
  image: string;
  /** Coordinate space of the marker: the desktop screen size in pixels. */
  width: number;
  height: number;
  /** Canonical action performed (click, drag, type, …). */
  action: string;
  /** Primary marker point in screen pixels (drag start / click / final cursor). Null if unknown. */
  x: number | null;
  y: number | null;
  /** Drag destination in screen pixels (only for action=drag). */
  x2?: number | null;
  y2?: number | null;
  /** Present when a visual_click target was snapped to an OCR text box — drives the "OCR" chip. */
  snap?: { text: string; x: number; y: number } | null;
}

/**
 * A media tool (`generate_image` / `generate_video` / `generate_sound` / `edit_image`) produced one or
 * more artifacts. Drives the chat's generation card. The pixels/bytes themselves ride the tool's
 * `tool:execution_complete` payload (pooled + persisted like any tool-acquired resource); this event
 * carries only the framing metadata, so nothing is sent twice over the wire.
 */
export interface MediaGeneratedPayload {
  ctx: EventContext;
  /** Correlates with the tool call that produced it. */
  callId: string;
  /**
   * `start` fires the instant ComfyUI accepts the job and carries only what is knowable then; `done`
   * fires on completion and adds the artifacts. Two emissions rather than one because a video takes
   * ten minutes, and naming the run only at the end leaves the card blank for the whole render. The
   * client merges them, so `start`-only fields survive.
   */
  phase: 'start' | 'done';
  kind: 'image' | 'video' | 'audio';
  prompt: string;
  negativePrompt: string | null;
  /** Name of the ComfyUI workflow that ran. */
  workflow: string;
  /** Its declared kind — `edit` is distinct from `image` even though both output an image. */
  workflowKind?: string;
  /** Weight files the graph loads: the clearest statement of what is actually running. */
  models?: string[];
  /** ComfyUI's id for this job, and the server it is running on — together they locate the run. */
  promptId?: string;
  comfyUrl?: string;
  /** Jobs ahead of this one when it was queued. */
  queuePosition?: number;
  /** Free / total VRAM on the tightest GPU at submit — what predicts an out-of-memory failure. */
  vramFreeBytes?: number;
  vramTotalBytes?: number;
  seed: number | null;
  /** Effective generation settings, rendered as chips (size, seconds, fps…). */
  params: Record<string, string | number>;
  /** Count of artifacts actually returned (`done` only). */
  count?: number;
  /** Resource handles of the artifacts, so the card can stream a video/audio by handle. */
  resourceIds?: string[];
  /** `edit_image` only: handle of the source image, for the before/after pair. */
  sourceId?: string | null;
}

/**
 * Incremental progress for a long-running tool call. Separate from `tool:output_chunk` (which appends
 * text) because a ten-minute ComfyUI render needs a bar, not a log. Deliberately not persisted by
 * `TurnRecorder` — it describes a moment, and means nothing once the turn has ended.
 */
export interface ToolProgressPayload {
  ctx: EventContext;
  callId: string;
  phase: 'queued' | 'running' | 'downloading';
  /** 0-100, or null before anything measurable has happened. */
  percent: number | null;
  /** Id and human label of the step currently executing (a ComfyUI node). */
  node?: string;
  nodeLabel?: string;
  /** Sampler steps within the current node, and graph nodes overall — a bar alone hides both. */
  step?: number;
  steps?: number;
  nodesDone?: number;
  nodesTotal?: number;
  /** Jobs ahead of this one on the remote server. */
  queuePosition?: number;
  elapsedMs: number;
  etaMs?: number | null;
  /**
   * Latest in-progress preview frame as a data URL, when the remote reports one. Replaced, never
   * accumulated, and never persisted — it is a glimpse of work in flight, worthless afterwards.
   */
  preview?: string;
  /**
   * Whether any preview has arrived this run. Lets the UI distinguish "the server isn't sending
   * previews" (ComfyUI defaults `--preview-method` to none) from "nothing has rendered yet".
   */
  sawPreview?: boolean;
  message?: string;
}

/**
 * One memory the auto-RAG step pulled out of the agent's Qdrant namespace and folded into its
 * system prompt for this run. Mirrors a Qdrant point's payload, narrowed to what the operator needs
 * to judge the recall.
 */
export interface RecalledMemory {
  text: string;
  /**
   * Composite rerank score that won this memory its slot — similarity, recency, importance and how
   * often it has proven useful before (see `agent-memory.service`). NOT the raw cosine: a memory can
   * outrank a more similar one by being recent, important, or repeatedly useful.
   */
  score: number;
  /** Raw cosine similarity to the turn's query (0–1), so the operator can see the two diverge. */
  similarity?: number;
  /** fact | preference | procedure | episode. */
  kind?: string;
  /** Short topic key the memory is filed under ("gpu-broker", "operator"). */
  subject?: string;
  /** 1–5; weighs into `score`. */
  importance?: number;
  /**
   * How the memory was written: `distiller` (the agent's own model rewrote a turn into it),
   * `remember_tool` (deliberate), or `auto_turn` (legacy raw-transcript capture, no longer written).
   */
  source?: string;
  /** ISO timestamp the memory was stored. */
  createdAt?: string;
}

/**
 * An agent-run recalled memories and injected them into its prompt (`AgentRunner`, before inference).
 * Emitted once per run — including each delegated sub-agent's — and only when the recall returned
 * something, so the chat's "memories" badge appears exactly when memory actually shaped the answer.
 */
export interface MemoryRecallPayload {
  ctx: EventContext;
  /** The agent-run these memories were injected into (depth-0 turn, or a sub-agent's own run). */
  runId: string;
  memories: RecalledMemory[];
}

/** One item of an agent's working checklist (`todowrite`). */
export interface TodoItemPayload {
  id: string;
  content: string;
  status: string;
}

/**
 * An agent rewrote its task list (`todowrite`). Emitted on every write so the pinned checklist in the
 * chat ticks over live rather than only once the turn settles. Carries `ctx.depth`, so a delegated
 * sub-agent's list is routed to its own bubble instead of replacing the orchestrator's.
 */
export interface TodoUpdatePayload {
  ctx: EventContext;
  /** Tool call that wrote it, so the UI can tie the update to its inline marker. */
  callId: string;
  items: TodoItemPayload[];
}

export interface ContextUsagePayload {
  ctx: EventContext;
  /** Prompt tokens on this inference pass — the current context size. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Model context window (n_ctx) so the UI can show usage as a fraction. */
  contextWindow: number;
  /**
   * `live` fires after every tool iteration so the UI meter climbs in real time (the transient
   * amber reading); `final` fires once when the turn settles, carrying its peak (the blue total
   * that persists). Only `final` is persisted.
   */
  phase: 'live' | 'final';
}

export interface AskUserPayload {
  ctx: EventContext;
  /** Correlates the modal shown in the UI with the client's `ask_user:response`. */
  requestId: string;
  question: string;
}

/** A turn hit the tool-round cap before producing a final answer — it was cut off mid-task. */
export interface TurnTruncatedPayload {
  ctx: EventContext;
}

/**
 * Raw llama-call capture events (the LLM Debug page). Emitted centrally by {@link LlamaClient} for
 * every HTTP call to the inference server (streamed turns + one-shot completes; not embeddings /
 * tokenize). `ctx` is optional because side tasks (title generation, embeddings) run outside a live
 * session — mirrors {@link SystemAlertPayload}. The persistence subscriber consumes the rich
 * `llama:call_end`; the WS bridge narrows all three to a global `llama-log` feed.
 */

/** Where a captured llama call originated — used to filter training noise later. */
export type LlamaCallSource =
  | 'chat-turn'
  | 'title-gen'
  | 'identity'
  | 'vision'
  | 'judge'
  | 'memory'
  /** The Conversation Generator's interviewer asking a target agent its next question. */
  | 'interview';

/** Token accounting mirrored from `TokenUsage` (kept structural to avoid an inference→events import). */
export interface LlamaUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The full outgoing request body as sent to the server (sampling + messages + tool schemas). */
export interface LlamaRequestCapture {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
}

/** The assembled response for one call (independent of raw streamed chunks). */
export interface LlamaResponseCapture {
  text: string;
  /**
   * The turn's thinking, when the server split it onto its own channel (`reasoning_content`) or it
   * was parsed out of inline `<think>` tags. Kept SEPARATE from `text`, never concatenated into it:
   * `text` is the assistant's actual content and is what feeds back into history, while this is the
   * hidden deliberation. Persisted so the SFT export can decide whether to train on it.
   */
  reasoning?: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  finishReason: string | null;
}

export interface LlamaCallStartPayload {
  ctx?: EventContext;
  /** Correlates start → deltas → end for one call. */
  id: string;
  source: LlamaCallSource;
  model: string;
  /** Normalized base URL actually used (post-failover). */
  endpoint: string;
  /** Outgoing request with image parts truncated to placeholders (live UI only). */
  requestPreview: LlamaRequestCapture;
}

export interface LlamaCallDeltaPayload {
  id: string;
  delta: string;
  isReasoning: boolean;
}

export interface LlamaCallEndPayload {
  ctx?: EventContext;
  id: string;
  /** Groups every call of one user turn (incl. sub-agent hops). */
  turnId?: string;
  /** The agent-run this call belongs to — the Conversation Quality Scorer's scored unit. */
  runId?: string;
  source: LlamaCallSource;
  model: string;
  endpoint: string;
  status: 'success' | 'error';
  startedAt: number;
  durationMs: number;
  /** Wall-clock ms from request send to first streamed token (null for non-streaming / no output). */
  firstTokenMs: number | null;
  usage: LlamaUsage | null;
  /** Full request (untruncated images) — the persistence layer truncates for the debug tier. */
  request: LlamaRequestCapture;
  response: LlamaResponseCapture;
  /** Raw text deltas exactly as streamed (empty for non-streaming `complete`). */
  rawChunks: string[];
  error?: string;
}

/**
 * An agent-run was scored by the Conversation Quality Scorer. Bridged to the turn's session room so
 * the chat can attach a live badge to the matching bubble (top-level turn or a sub-agent bubble, by
 * `runId`). `sessionId` may be null for side turns — the bridge forwards to the room only when present.
 */
export interface TurnScoredPayload {
  sessionId: string | null;
  /** The scored agent-run (the badge target). */
  runId: string;
  /** The user turn this run belongs to (groups parent + sub-agent runs). */
  turnId: string;
  agentName: string | null;
  depth: number | null;
  score: number;
  tag: 'Perfect' | 'Patched' | 'Recovered' | 'Rejected';
  explanation: string;
}

/**
 * A tracked fine-tune job changed on its remote server. Emitted by `finetune/poller.ts` each time
 * it observes new status/progress/metrics, so the Fine-Tuning page's loss curve updates live.
 */
export interface FinetuneJobUpdatePayload {
  /** The `finetune_jobs` document id (the UI's key), not the remote job id. */
  jobId: string;
  serverId: string;
  runName: string;
  status: 'queued' | 'preparing' | 'training' | 'exporting' | 'done' | 'failed';
  progress: number;
  /** Only the datapoints observed since the previous tick — the client appends them. */
  newMetrics: { step: number; loss: number; epoch?: number; lr?: number; at: string }[];
  ggufFilename?: string;
  error?: string;
}

export type AlertLevel = 'info' | 'warn' | 'error';

export interface SystemAlertPayload {
  /** Optional: some alerts (e.g. global) are not tied to a live session. */
  ctx?: EventContext;
  level: AlertLevel;
  message: string;
}

// ---------------------------------------------------------------------------
// Conversation Generator (docs/conversation-generator.md)
// ---------------------------------------------------------------------------

/**
 * A generated conversation just opened a session. Broadcast (not room-scoped): no client is in the
 * new session's room yet, and every open Workspace wants the row to appear in its sidebar live.
 */
export interface ConversationSessionCreatedPayload {
  sessionId: string;
  agentId: string;
  agentName: string;
  title: string;
}

/**
 * One exchange of a generated conversation finished and was persisted by the generator. Carries the
 * assembled turn so a Workspace watching this session settles its live buffer into a finished turn —
 * exactly as it does for a chat the operator drove.
 */
export interface ConversationTurnCompletePayload {
  ctx: EventContext;
  answer: string;
  blocks: unknown[];
  memories?: RecalledMemory[];
  turnId: string;
  runId: string;
}

// ---------------------------------------------------------------------------
// Flows (FLOWS_PLAN.md)
// ---------------------------------------------------------------------------

/**
 * Flow events all carry an `EventContext` whose `sessionId` is the **run id** (flows spec §1.1), so
 * `bridge.ts` relays them with the same room-scoped line as everything else — and a page watching a
 * run also receives, for free, the `stream_chunk` / `tool_progress` / `media_gen` events emitted by
 * the agent and media nodes executing inside it.
 */
export interface FlowRunStartPayload {
  ctx: EventContext;
  runId: string;
  flowId: string;
  flowName: string;
  trigger: string;
}

export interface FlowNodeStartPayload {
  ctx: EventContext;
  runId: string;
  nodeId: string;
  nodeType: string;
  label: string;
  /** Set inside a `for_each` body, so repeated executions are distinguishable in the UI. */
  iteration?: number;
}

export interface FlowNodeProgressPayload {
  ctx: EventContext;
  runId: string;
  nodeId: string;
  phase: 'queued' | 'running' | 'downloading';
  percent?: number | null;
  message?: string;
  /** Latest in-progress preview frame (data URL) from ComfyUI, when the remote provides one. */
  preview?: string;
  etaMs?: number | null;
  elapsedMs: number;
}

/** A line of live output from a node (agent tokens, tool stdout, a milestone). */
export interface FlowNodeOutputPayload {
  ctx: EventContext;
  runId: string;
  nodeId: string;
  chunk: string;
}

export interface FlowNodeEndPayload {
  ctx: EventContext;
  runId: string;
  nodeId: string;
  status: 'success' | 'error' | 'skipped';
  durationMs: number;
  /** Truncated text rendering of the output, for the node card. */
  summary?: string;
  /** Handles the node produced, so the canvas can show a thumbnail without a refetch. */
  handles?: string[];
  error?: string;
}

export interface FlowRunEndPayload {
  ctx: EventContext;
  runId: string;
  status: 'success' | 'error' | 'aborted';
  durationMs: number;
  output?: string;
  handles?: string[];
  error?: string;
}

/**
 * A node persisted an artifact into the run.
 *
 * Emitted at the moment the bytes are stored rather than when the node finishes, for two reasons: a
 * node that produces several files announces each as it lands, and it catches artifacts that leave
 * on a secondary port (an `ask_agent` node handing back images) which a node-completion event would
 * miss. That is what lets the Media tab fill in during a run instead of at the end of it.
 */
export interface FlowArtifactPayload {
  ctx: EventContext;
  runId: string;
  nodeId: string;
  handle: string;
  kind: 'image' | 'blob';
  mime: string;
  size: number;
  filename?: string;
  /** Set inside a `for_each` body, so a gallery can group by shot. */
  iteration?: number;
}

/** The run is blocked on the operator's decision at an `approval` node. */
export interface FlowAwaitingApprovalPayload {
  ctx: EventContext;
  runId: string;
  nodeId: string;
  question: string;
  artifacts: string[];
}

// ---------------------------------------------------------------------------
// Event name → payload map
// ---------------------------------------------------------------------------

export interface EventMap {
  'chat:user_message': UserMessagePayload;
  'conversation:session_created': ConversationSessionCreatedPayload;
  'conversation:turn_complete': ConversationTurnCompletePayload;
  'agent:stream_chunk': StreamChunkPayload;
  'agent:tool_invoke': ToolInvokePayload;
  'tool:output_chunk': ToolOutputChunkPayload;
  'tool:vision': VisionAnalysisPayload;
  'tool:visual_act': VisualActPayload;
  'agent:media_generated': MediaGeneratedPayload;
  'tool:progress': ToolProgressPayload;
  'tool:execution_complete': ToolCompletePayload;
  'agent:ask_agent': AskAgentPayload;
  'agent:ask_agent_done': AskAgentDonePayload;
  'agent:memory_recall': MemoryRecallPayload;
  'agent:todo_update': TodoUpdatePayload;
  'agent:context_usage': ContextUsagePayload;
  'agent:turn_truncated': TurnTruncatedPayload;
  'agent:ask_user': AskUserPayload;
  'system:alert': SystemAlertPayload;
  'llama:call_start': LlamaCallStartPayload;
  'llama:call_delta': LlamaCallDeltaPayload;
  'llama:call_end': LlamaCallEndPayload;
  'scoring:turn_scored': TurnScoredPayload;
  'finetune:job_update': FinetuneJobUpdatePayload;
  'flow:run_start': FlowRunStartPayload;
  'flow:node_start': FlowNodeStartPayload;
  'flow:node_progress': FlowNodeProgressPayload;
  'flow:node_output': FlowNodeOutputPayload;
  'flow:node_end': FlowNodeEndPayload;
  'flow:run_end': FlowRunEndPayload;
  'flow:awaiting_approval': FlowAwaitingApprovalPayload;
  'flow:artifact': FlowArtifactPayload;
}

export type EventName = keyof EventMap;
