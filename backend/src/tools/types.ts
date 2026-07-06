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
   * Returns the sub-agent's final text answer. `images` (optional) forwards attachments to the
   * sub-agent's turn (e.g. hand a user-dropped image to a vision specialist).
   */
  invokeSubAgent?: (targetAgentName: string, query: string, images?: ImageBlock[]) => Promise<string>;
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
  emitVision?: (payload: { image: string; question: string; answer: string; model: string }) => void;
  /**
   * Images the user attached to this turn (data URLs). Available to `analyze_image` (to describe them
   * via the Vision endpoint) and forwardable to a subagent via `ask_agent`. A multimodal agent also
   * receives them directly in its context; a text-only agent only reaches them through these tools.
   */
  attachedImages?: ImageBlock[];
}

export interface ToolResult {
  /** Structured payload fed back into the inference loop (stringified for the model). */
  result: unknown;
  /** Base64 images the tool produced, appended to context by the JIT builder. */
  images?: ImageBlock[];
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
