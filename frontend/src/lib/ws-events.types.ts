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
  | ContextUsageEvent;
