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

export interface ImageBlock {
  /** Base64 data URL, e.g. `data:image/png;base64,...` — llama.cpp multimodal input. */
  dataUrl: string;
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

export type AlertLevel = 'info' | 'warn' | 'error';

export interface SystemAlertPayload {
  /** Optional: some alerts (e.g. global) are not tied to a live session. */
  ctx?: EventContext;
  level: AlertLevel;
  message: string;
}

// ---------------------------------------------------------------------------
// Event name → payload map
// ---------------------------------------------------------------------------

export interface EventMap {
  'chat:user_message': UserMessagePayload;
  'agent:stream_chunk': StreamChunkPayload;
  'agent:tool_invoke': ToolInvokePayload;
  'tool:output_chunk': ToolOutputChunkPayload;
  'tool:vision': VisionAnalysisPayload;
  'tool:visual_act': VisualActPayload;
  'tool:execution_complete': ToolCompletePayload;
  'agent:ask_agent': AskAgentPayload;
  'agent:ask_agent_done': AskAgentDonePayload;
  'agent:context_usage': ContextUsagePayload;
  'agent:turn_truncated': TurnTruncatedPayload;
  'agent:ask_user': AskUserPayload;
  'system:alert': SystemAlertPayload;
}

export type EventName = keyof EventMap;
