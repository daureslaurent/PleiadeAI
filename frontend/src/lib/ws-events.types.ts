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

export type WsEvent =
  | StreamChunkEvent
  | AgentHopEvent
  | AgentHopDoneEvent
  | ToolStartEvent
  | ToolOutputEvent
  | ToolEndEvent
  | VisionEvent
  | SystemAlertEvent
  | AskUserEvent
  | TruncatedEvent
  | ContextUsageEvent
  | LlamaCallStartEvent
  | LlamaCallDeltaEvent
  | LlamaCallEndEvent
  | TurnScoredEvent;
