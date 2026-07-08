/**
 * Conversation Quality Scorer — types (spec: Conversation Quality Scorer feature).
 *
 * Unit of evaluation is a **turn**: every llama HTTP call sharing a `turn_id` (one user message plus
 * the whole tool-call / error-recovery sequence it triggered, including sub-agent hops). An
 * LLM-as-judge rates the turn 0–100 and tags it, for building an SFT dataset.
 */

/** The four rulings the judge chooses from. */
export type ScoreTag = 'Perfect' | 'Patched' | 'Recovered' | 'Rejected';

/** Band boundaries (inclusive lower bounds), used to sanity-check the judge's numeric score vs tag. */
export const SCORE_BANDS: Record<ScoreTag, [number, number]> = {
  Perfect: [90, 100],
  Patched: [70, 89],
  Recovered: [70, 89],
  Rejected: [0, 69],
};

/** One assistant→tool step reconstructed from the raw archive, in call order. */
export interface TurnStep {
  /** 0-based index of this llama HTTP call within the turn. */
  index: number;
  agentName: string | null;
  /** Cross-agent hop depth (0 = the user-facing agent, >0 = a delegated sub-agent). */
  depth: number | null;
  /** Assistant free-text content of this call's response (usually empty when it emits tool calls). */
  content: string;
  /** Native tool calls the model emitted this step, with RAW (pre-repair) argument JSON. */
  toolCalls: { id: string; name: string; argsJson: string }[];
  /** Tool-role results that arrived as inputs to the NEXT call (i.e. outcomes of this step's calls). */
  toolResults: { name: string | null; content: string; isError: boolean }[];
  finishReason: string | null;
  status: 'success' | 'error';
}

/**
 * The assembled input the judge scores: one agent-run, flattened from its archive records.
 * `toolCatalog` is the set of tool names actually offered to the model (from the request `tools[]`),
 * so the judge can detect a hallucinated tool. `userRequest` is the message that opened this run (the
 * user's message for the top-level agent, or the delegated task for a sub-agent).
 */
export interface TurnLog {
  /** The scored agent-run. */
  runId: string;
  /** The user turn this run belongs to (groups parent + sub-agent runs). */
  turnId: string;
  agentName: string | null;
  /** Hop depth: 0 = the user-facing agent, >0 = a delegated sub-agent. */
  depth: number | null;
  sessionId: string | null;
  /** Tool names offered to the model this turn (union across calls). Hallucination = a call outside this. */
  toolCatalog: string[];
  /** The user instruction that opened the turn (best-effort extraction from the first request). */
  userRequest: string;
  steps: TurnStep[];
  /** The agent's final assistant text answer, if the turn ended with prose rather than a tool call. */
  finalAnswer: string;
  /** Objective signals precomputed from the transcript, handed to the judge as hints (not verdicts). */
  signals: TurnSignals;
}

/**
 * Cheap, deterministic facts computed from the raw records — the judge is told these as evidence so
 * it doesn't have to re-derive them, but it still owns the final ruling. See `turn-assembler.ts`.
 */
export interface TurnSignals {
  callCount: number;
  /** A tool call whose name is not in `toolCatalog` — a hallucinated tool. */
  hallucinatedTool: boolean;
  /** Any native tool call whose raw `argsJson` failed to JSON.parse (a malformed-args emission). */
  malformedArgs: boolean;
  /** The model emitted no native tool call but leaked tool syntax in `content` (backend salvage path). */
  textFormatToolLeak: boolean;
  /** A tool-role result flagged an error at least once (drove an error-recovery loop). */
  sawToolError: boolean;
  /** A tool error occurred and a LATER call to the same tool then succeeded (self-correction). */
  recoveredAfterError: boolean;
  /** The turn hit the tool-round cap without finishing (possible infinite error loop). */
  hitIterationCap: boolean;
  /** The final assistant message is prose with no tool call anywhere in the turn. */
  answeredWithoutToolCall: boolean;
}

/** The judge's raw JSON output (validated against this before persistence). */
export interface JudgeVerdict {
  score: number;
  tag: ScoreTag;
  explanation: string;
}

/** A persisted score for one agent-run. */
export interface ConversationScore extends JudgeVerdict {
  runId: string;
  turnId: string;
  agentName: string | null;
  depth: number | null;
  sessionId: string | null;
  /** The judge model + endpoint that produced this ruling (for auditing / re-scoring decisions). */
  judgeModel: string;
  /** `auto` = scored on turn completion; `batch` = produced by a "score all" run; `manual` = one-off. */
  origin: 'auto' | 'batch' | 'manual';
  createdAt: Date;
}
