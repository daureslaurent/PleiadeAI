/**
 * Text → tool-call fallback recovery.
 *
 * The app drives inference through native OpenAI-style function calling (see `LlamaClient`): the
 * model is expected to emit tool calls on the structured `tool_calls` channel, which we execute.
 * But local models served by a misconfigured llama.cpp (missing `--jinja` / no tool-call parser),
 * or simply an unreliable model, sometimes *narrate* a call as prose instead — e.g. a turn whose
 * text is `[ask_user] What colour should the button be?` with no native `tool_calls`. That leaks
 * the bracket text to the user and, worse, never runs the tool.
 *
 * This parser is a best-effort safety net: given an assistant turn that produced *no* native tool
 * calls, it tries to recover a call the model clearly intended, and only ever emits a call whose
 * name is in the agent's actual toolset. It is deliberately conservative — the real fix is a
 * correctly-configured server + the system-prompt directive; this just keeps a stray narration from
 * silently dropping the tool.
 */

/** Minimal view of a resolved tool the parser needs to validate/shape a recovered call. */
export interface KnownTool {
  name: string;
  /** JSON-schema `parameters` object (`{ type:'object', properties, required }`). */
  parameters: Record<string, unknown>;
}

/** A recovered call, shaped like the native `AssembledToolCall` minus the server-issued id. */
export interface FallbackToolCall {
  name: string;
  /** JSON arguments string, ready to hand to the same path as a native call. */
  argsJson: string;
}

interface SchemaShape {
  properties: Record<string, unknown>;
  required: string[];
}

function schemaShape(tool: KnownTool): SchemaShape {
  const params = tool.parameters ?? {};
  const properties = (params.properties as Record<string, unknown>) ?? {};
  const required = Array.isArray(params.required) ? (params.required as string[]) : [];
  return { properties, required };
}

/**
 * The single free-text parameter a bracket-narrated call should fill, if the tool has exactly one
 * natural slot (e.g. `ask_user`/`ask_parent` → `question`). Returns null for zero-param or
 * multi-param tools, where prose can't be mapped to arguments safely.
 */
function soleParam(tool: KnownTool): string | null {
  const { properties, required } = schemaShape(tool);
  const keys = Object.keys(properties);
  if (keys.length === 1) return keys[0] ?? null;
  const [only] = required;
  if (required.length === 1 && only && properties[only]) return only;
  return null;
}

/** Collect JSON-object candidates the model may have emitted as text instead of a native call. */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  // Hermes/Qwen style: <tool_call>{ ... }</tool_call>
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) if (m[1]) out.push(m[1]);
  // Fenced JSON blocks: ```json { ... } ```
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) if (m[1]) out.push(m[1]);
  // A whole message that is itself a bare JSON object.
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) out.push(trimmed);
  return out;
}

/** Recover calls from JSON-shaped emissions (`{ "name": "...", "arguments": { ... } }`). */
function fromJson(text: string, byName: Map<string, KnownTool>): FallbackToolCall[] {
  const out: FallbackToolCall[] = [];
  for (const raw of jsonCandidates(text)) {
    let obj: unknown;
    try {
      obj = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const rec = obj as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name : undefined;
    if (!name || !byName.has(name)) continue;
    // Require an explicit arguments/parameters object so we don't misread arbitrary JSON that
    // merely happens to carry a `name` field.
    const argsRaw = rec.arguments ?? rec.parameters;
    const args =
      argsRaw && typeof argsRaw === 'object' ? (argsRaw as Record<string, unknown>) : undefined;
    if (args === undefined) continue;
    out.push({ name, argsJson: JSON.stringify(args) });
  }
  return out;
}

/**
 * Recover a single bracket-narrated call: a line that starts with `[tool_name]` (optionally after
 * list/quote markers), followed by prose. Filled only when the tool has zero params (`[annuaire]`)
 * or exactly one natural slot we can pour the trailing text into.
 */
function fromBracket(text: string, byName: Map<string, KnownTool>): FallbackToolCall | null {
  const m = text.match(/(?:^|\n)[ \t>*-]*\[([a-zA-Z_][a-zA-Z0-9_]*)\][ \t]*:?[ \t]*([\s\S]*)/);
  if (!m || !m[1]) return null;
  const tool = byName.get(m[1]);
  if (!tool) return null;

  const { properties } = schemaShape(tool);
  if (Object.keys(properties).length === 0) {
    return { name: tool.name, argsJson: '{}' };
  }
  const param = soleParam(tool);
  const rest = (m[2] ?? '').trim();
  if (!param || !rest) return null; // multi-param or nothing to fill → don't fabricate
  return { name: tool.name, argsJson: JSON.stringify({ [param]: rest }) };
}

/** Bracket-narration matcher, shared by recovery and detection: `[tool_name]` at a line start. */
const BRACKET_TOOL_RE = /(?:^|\n)[ \t>*-]*\[([a-zA-Z_][a-zA-Z0-9_]*)\]/g;

/**
 * Detect that an assistant turn *narrated* a tool call as prose but we could not recover it into a
 * real call — e.g. a bare `[ask_agent]` (no arguments) or `[ask_agent → websearch]` (a multi-arg
 * tool the conservative recovery won't fabricate arguments for). Used by the runner to nudge the
 * model back onto the native tool channel and retry, instead of returning the leaked bracket as the
 * final answer. Only fires for brackets whose name is a real tool in this agent's toolset.
 */
export function detectNarratedTools(text: string, tools: KnownTool[]): string[] {
  if (!text.trim() || tools.length === 0) return [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const found = new Set<string>();
  for (const m of text.matchAll(BRACKET_TOOL_RE)) {
    if (m[1] && byName.has(m[1])) found.add(m[1]);
  }
  return [...found];
}

/**
 * Try to recover the tool call(s) an assistant turn intended but emitted as plain text. Called only
 * when the turn produced no native `tool_calls`. Returns `[]` when nothing safe to recover is found.
 */
export function parseFallbackToolCalls(text: string, tools: KnownTool[]): FallbackToolCall[] {
  if (!text.trim() || tools.length === 0) return [];
  const byName = new Map(tools.map((t) => [t.name, t]));

  const jsonCalls = fromJson(text, byName);
  if (jsonCalls.length) return jsonCalls;

  const bracket = fromBracket(text, byName);
  return bracket ? [bracket] : [];
}
