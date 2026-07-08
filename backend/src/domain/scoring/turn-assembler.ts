import type { LlamaLogDoc } from '../llama-logs/llama-log.repository';
import type { TurnLog, TurnStep, TurnSignals } from './scoring.types';

/**
 * Mirrors `DEFAULT_MAX_TOOL_ITERATIONS` in AgentRunner (kept local to avoid importing the orchestrator
 * into a domain module). Only used as a soft "possible infinite loop" hint; per-agent overrides may
 * differ, so the judge treats `hitIterationCap` as evidence, not proof.
 */
const DEFAULT_MAX_TOOL_ITERATIONS = 20;

/**
 * Reconstruct a scoreable {@link TurnLog} from the raw llama archive records of one turn.
 *
 * Each record is one HTTP call: its `response` holds the assistant output (RAW, pre-repair native
 * `toolCalls` + `content`), and the tool-role results of a call show up in *later* records'
 * `request.messages`. We collect every tool result across the turn (keyed by `tool_call_id`) and
 * attach each to the call that produced it, so a step carries both what the model asked for and what
 * came back — the evidence the judge needs for Patched / Recovered / Rejected.
 */

type Msg = { role?: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string };

/** Normalise an OpenAI message `content` (string | array of parts | null) to plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('');
  }
  return '';
}

/** Heuristic: does a tool-role result represent an error? Tools return JSON like `{ok:false,error}`. */
function isErrorResult(content: string): boolean {
  const c = content.trim();
  if (/unknown tool:/i.test(c)) return true;
  try {
    const obj = JSON.parse(c) as Record<string, unknown>;
    if (obj && typeof obj === 'object') {
      if (obj.ok === false) return true;
      if (typeof obj.error === 'string' && obj.error.length > 0) return true;
      if (obj.isError === true) return true;
    }
  } catch {
    // Non-JSON result: only treat as error on an explicit leading "error".
    if (/^error[:\s]/i.test(c)) return true;
  }
  return false;
}

/** Tool-syntax leaked into plain text (the backend salvage path) — mirrors ToolCallFallbackParser. */
function hasTextFormatToolLeak(text: string, toolCatalog: Set<string>): boolean {
  if (!text) return false;
  if (/<tool_call>[\s\S]*?<\/tool_call>/i.test(text)) return true;
  // A [tool_name] bracket line naming a real tool.
  for (const m of text.matchAll(/(?:^|\n)[ \t>*-]*\[([a-zA-Z_][a-zA-Z0-9_]*)\]/g)) {
    if (m[1] && toolCatalog.has(m[1])) return true;
  }
  // A fenced or bare JSON object that names a real tool.
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) if (m[1]) candidates.push(m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed);
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
      if (obj && typeof obj.name === 'string' && toolCatalog.has(obj.name) && (obj.arguments ?? obj.parameters)) {
        return true;
      }
    } catch {
      /* not JSON */
    }
  }
  return false;
}

function toolNamesFrom(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const t of tools) {
    const fn = (t as { function?: { name?: unknown } })?.function;
    if (fn && typeof fn.name === 'string') names.push(fn.name);
  }
  return names;
}

/**
 * Build the {@link TurnLog} from ONE agent-run's archive records (already sorted oldest-first).
 * Returns null if there are no records. Robust to malformed args (surfaced as a `malformedArgs`
 * signal). The run is the scored unit: for a delegated sub-agent these records are only that
 * sub-agent's own calls, so it is judged on its own conversation.
 */
export function assembleRun(records: LlamaLogDoc[]): TurnLog | null {
  if (records.length === 0) return null;
  const first = records[0]!;
  const runId = String(first.run_id ?? '');
  const turnId = String(first.turn_id ?? '');
  const sessionId = first.session_id ?? null;
  const agentName = first.agent_name ?? null;
  const depth = first.depth ?? null;

  // Tool catalog: union of tool names offered across every call this turn.
  const catalog = new Set<string>();
  for (const rec of records) for (const n of toolNamesFrom((rec.request as { tools?: unknown }).tools)) catalog.add(n);

  // The instruction that opened THIS run: the LAST user-role message of the first record. A run's
  // first inference call carries the whole prior conversation (system + history) with the current
  // request appended last, so the *first* user message is the oldest turn in the session — for a
  // multi-turn top-level agent that is a stale greeting, not what this turn asked. Taking the last
  // user message yields the current request for the top-level agent and the delegated task for a
  // sub-agent (whose first call has only [system, user task]).
  const firstMsgs = ((first.request as { messages?: Msg[] }).messages ?? []) as Msg[];
  const lastUserMsg = [...firstMsgs].reverse().find((m) => m.role === 'user');
  const userRequest = textOf(lastUserMsg?.content ?? '');

  // Every tool result across the turn, keyed by tool_call_id.
  const resultsById = new Map<string, { name: string | null; content: string; isError: boolean }>();
  for (const rec of records) {
    const msgs = ((rec.request as { messages?: Msg[] }).messages ?? []) as Msg[];
    for (const m of msgs) {
      if (m.role === 'tool' && typeof m.tool_call_id === 'string' && !resultsById.has(m.tool_call_id)) {
        const content = textOf(m.content);
        resultsById.set(m.tool_call_id, { name: null, content, isError: isErrorResult(content) });
      }
    }
  }

  const steps: TurnStep[] = [];
  let malformedArgs = false;
  let hallucinatedTool = false;
  let textFormatToolLeak = false;

  records.forEach((rec, index) => {
    const resp = rec.response as {
      text?: string;
      toolCalls?: { id: string; name: string; argsJson: string }[];
      finishReason?: string | null;
    };
    const content = resp.text ?? '';
    const toolCalls = resp.toolCalls ?? [];
    for (const c of toolCalls) {
      try {
        JSON.parse(c.argsJson);
      } catch {
        malformedArgs = true;
      }
      if (!catalog.has(c.name)) hallucinatedTool = true;
      // Tag each result with the tool name of the call that produced it.
      const r = resultsById.get(c.id);
      if (r && r.name === null) r.name = c.name;
    }
    if (toolCalls.length === 0 && hasTextFormatToolLeak(content, catalog)) textFormatToolLeak = true;

    steps.push({
      index,
      agentName: rec.agent_name ?? null,
      depth: rec.depth ?? null,
      content,
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, argsJson: c.argsJson })),
      toolResults: toolCalls.map((c) => resultsById.get(c.id)).filter((r): r is NonNullable<typeof r> => !!r),
      finishReason: resp.finishReason ?? null,
      status: (rec.status as 'success' | 'error') ?? 'success',
    });
  });

  // Recovery: an error result, then a later call to the same tool whose result is not an error.
  const sawToolError = [...resultsById.values()].some((r) => r.isError);
  const recoveredAfterError = detectRecovery(steps);

  // Iteration cap: this run made at least the max number of tool-bearing rounds (a possible loop).
  const hitIterationCap = records.length >= DEFAULT_MAX_TOOL_ITERATIONS;

  const anyToolCall = steps.some((s) => s.toolCalls.length > 0);
  const last = records[records.length - 1]!;
  const finalAnswer = ((last.response as { toolCalls?: unknown[]; text?: string }).toolCalls?.length ?? 0) === 0
    ? String((last.response as { text?: string }).text ?? '')
    : '';
  const answeredWithoutToolCall = !anyToolCall && finalAnswer.trim().length > 0;

  const signals: TurnSignals = {
    callCount: records.length,
    hallucinatedTool,
    malformedArgs,
    textFormatToolLeak,
    sawToolError,
    recoveredAfterError,
    hitIterationCap,
    answeredWithoutToolCall,
  };

  return { runId, turnId, agentName, depth, sessionId, toolCatalog: [...catalog], userRequest, steps, finalAnswer, signals };
}

/** A tool errored on some call, and a later call to the SAME tool came back without an error. */
function detectRecovery(steps: TurnStep[]): boolean {
  const erroredTools = new Set<string>();
  for (const step of steps) {
    // First, does this step succeed on a tool that previously errored?
    for (const r of step.toolResults) {
      if (r.name && !r.isError && erroredTools.has(r.name)) return true;
    }
    // Then record this step's errors so a later step can be the recovery.
    for (const r of step.toolResults) {
      if (r.name && r.isError) erroredTools.add(r.name);
    }
  }
  return false;
}
