import type { TurnLog } from './scoring.types';

/**
 * LLM-as-judge prompt + output contract for the Conversation Quality Scorer.
 *
 * The judge scores ONE turn of a native OpenAI-style function-calling agent (no ReAct text tags — the
 * agent emits native `tool_calls`). The rubric is intentionally strict and deterministic so scores are
 * reproducible at temperature 0. Objective signals are precomputed (`TurnSignals`) and handed to the
 * judge as evidence; the judge still owns the final ruling and the fuzzy judgments (correct tool
 * choice, task completion).
 */

/** Strict JSON schema the judge MUST return (embedded in the prompt; also used to validate output). */
export const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'tag', 'explanation'],
  properties: {
    score: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Overall quality of the turn, 0–100. Must fall inside the band of the chosen tag.',
    },
    tag: {
      type: 'string',
      enum: ['Perfect', 'Patched', 'Recovered', 'Rejected'],
      description: 'The ruling. Perfect 90–100, Patched 70–89, Recovered 70–89, Rejected 0–69.',
    },
    explanation: {
      type: 'string',
      maxLength: 400,
      description: 'One or two sentences justifying the ruling, citing the specific evidence.',
    },
  },
} as const;

/**
 * The judge System Prompt. Kept as a constant (not a template) so it's the single reviewable source
 * of the rubric; the turn-specific data is supplied in the user message by {@link buildJudgeUserMessage}.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a strict, impartial evaluator building a Supervised Fine-Tuning (SFT) dataset for a tool-calling AI agent. You score ONE "turn": a single user request plus the complete sequence of the agent's native tool calls, the tool results returned to it, and any error-recovery attempts (a turn may also include calls made by delegated sub-agents).

The agent uses the native OpenAI function-calling protocol. Correct behavior is emitting a native tool_call (a name from its provided tool list + a valid JSON arguments object) — NOT writing tool syntax as plain text, and NOT answering in the content field when a tool was required.

Assign an integer score from 0 to 100 and exactly one tag. Use this rubric precisely:

════════ PERFECT — score 90–100 ════════
ALL of the following hold:
- The agent selected the correct tool(s) for the user's request, chosen from its provided tool list.
- Each tool_call used the NATIVE tool_calls channel (not tool syntax leaked into the content field).
- The JSON arguments were well-formed and valid on the FIRST attempt (no malformed arguments).
- No error-recovery loop was needed and the backend did not have to repair or salvage the call.
- The task was successfully completed (tool results indicate success and the outcome satisfies the request).
A turn that correctly and directly answers a request that genuinely required NO tool (pure conversation) is also Perfect.

════════ PATCHED — score 70–89 ════════
The agent achieved the goal, BUT the backend had to repair its output before the tool could run. Signs:
- The model did NOT produce a clean native tool_call — it leaked tool syntax into the content field (e.g. <tool_call>{...}</tool_call>, a fenced json block, a bare JSON object, or a [tool_name] bracket line) and the backend salvaged it into a real call; OR
- The native tool_call arguments were malformed JSON that the backend had to fix.
AND the intended tool ultimately executed and the task was completed. Prefer Patched over Recovered when the fix was a formatting/parsing repair rather than the agent reasoning its way out of a returned error.

════════ RECOVERED — score 70–89 ════════
The agent hit a genuine error and corrected ITSELF across turns:
- It issued a tool_call, the tool result returned an error, and the agent then issued a corrected tool_call that succeeded and completed the task.
Use Recovered (not Patched) when the recovery came from the agent's own next attempt after seeing an error, not from a backend repair. If both a backend repair AND a self-recovery occurred, choose the one that was decisive for completing the task; when in doubt between Patched and Recovered, pick the lower-scoring interpretation.

════════ REJECTED — score 0–69 ════════
ANY of the following:
- The agent called a tool whose name is NOT in its provided tool list (hallucinated tool).
- The agent got stuck in a loop of repeated tool errors without recovering (never completed the task).
- The agent answered in the content field when it clearly should have called a tool to do the work.
- The task was not completed, or the turn is incoherent.
Within Rejected, use 55–69 for a coherent-but-wrong turn (e.g. answered instead of calling a tool, or one clean failure), and 0–40 for incoherent/hallucinated/looping garbage.

RULES:
- The score MUST fall inside the band of the tag you choose (Perfect 90–100, Patched/Recovered 70–89, Rejected 0–69).
- Judge only what the transcript shows. The precomputed SIGNALS are reliable evidence — use them, but confirm against the transcript.
- Be conservative: if a turn only "probably" succeeded, do not give Perfect.
- Output ONLY a single JSON object, no prose, no markdown fences, matching exactly:
{"score": <int 0-100>, "tag": "Perfect"|"Patched"|"Recovered"|"Rejected", "explanation": "<1-2 sentences citing the evidence>"}`;

/**
 * Second-pass nudge. A reasoning judge model often deliberates in *untagged* prose (no `<think>`
 * wrapper) and burns its whole `scoring_max_tokens` budget before emitting the verdict — the call
 * comes back `finishReason: 'length'` with no JSON in it at all, and the run is silently left
 * unscored. This happens most on delegated sub-agent runs, whose transcripts ("did this even need a
 * tool?") invite the longest deliberation, so a multi-sub-agent conversation ends up with a score on
 * the top-level turn and none on its sub-agent bubbles.
 *
 * On a parse failure we hand the model its own (possibly truncated) reasoning back and ask for
 * nothing but the verdict, with a small token budget it cannot overrun with more prose.
 */
export const JUDGE_RETRY_NUDGE =
  'STOP. Your deliberation above is finished and must not continue. ' +
  'Reply with ONLY the JSON verdict object — no reasoning, no explanation before it, no markdown fences. ' +
  'Your entire reply must start with { and end with }. ' +
  'If your reasoning above was cut off before you reached a conclusion, decide now from the transcript and the rubric.\n' +
  '{"score": <int 0-100>, "tag": "Perfect"|"Patched"|"Recovered"|"Rejected", "explanation": "<1-2 sentences citing the evidence>"}';

/** Build the user message carrying one turn's transcript + precomputed signals for the judge. */
export function buildJudgeUserMessage(turn: TurnLog): string {
  const steps = turn.steps
    .map((s) => {
      const calls = s.toolCalls.length
        ? s.toolCalls.map((c) => `    → tool_call: ${c.name}  args=${c.argsJson}`).join('\n')
        : '    → (no native tool_call)';
      const results = s.toolResults.length
        ? s.toolResults
            .map((r) => `    ← result[${r.name ?? '?'}] ${r.isError ? 'ERROR ' : ''}${truncate(r.content, 500)}`)
            .join('\n')
        : '';
      const content = s.content.trim() ? `    content: ${truncate(s.content, 500)}\n` : '';
      return `  [call ${s.index}] agent=${s.agentName ?? '?'} depth=${s.depth ?? 0} finish=${s.finishReason ?? '?'}\n${content}${calls}${results ? '\n' + results : ''}`;
    })
    .join('\n');

  const sig = turn.signals;
  const signalLines = [
    `callCount=${sig.callCount}`,
    `hallucinatedTool=${sig.hallucinatedTool}`,
    `malformedArgs=${sig.malformedArgs}`,
    `textFormatToolLeak=${sig.textFormatToolLeak}`,
    `sawToolError=${sig.sawToolError}`,
    `recoveredAfterError=${sig.recoveredAfterError}`,
    `hitIterationCap=${sig.hitIterationCap}`,
    `answeredWithoutToolCall=${sig.answeredWithoutToolCall}`,
  ].join(', ');

  return [
    `USER REQUEST:\n${truncate(turn.userRequest, 1500) || '(empty)'}`,
    ``,
    `TOOLS AVAILABLE TO THE AGENT (${turn.toolCatalog.length}): ${turn.toolCatalog.join(', ') || '(none)'}`,
    ``,
    `PRECOMPUTED SIGNALS: ${signalLines}`,
    ``,
    `TRANSCRIPT (in call order):\n${steps || '  (no steps)'}`,
    ``,
    `FINAL ASSISTANT ANSWER:\n${truncate(turn.finalAnswer, 1000) || '(none — turn ended on a tool call)'}`,
    ``,
    `Return only the JSON verdict.`,
  ].join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [+${s.length - max} chars]`;
}
