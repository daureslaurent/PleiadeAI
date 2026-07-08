import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import { resolveInference, resolveForEndpoint, type ResolvedInference } from '../../inference/inference-resolver';
import { settingsService } from '../settings/settings.service';
import type { AgentDoc } from '../agents/agent.model';
import type { ChatMessage } from '../agents/jit-builder';
import { JUDGE_RETRY_NUDGE, JUDGE_SYSTEM_PROMPT, buildJudgeUserMessage } from './judge-prompt';
import { SCORE_BANDS, type JudgeVerdict, type ScoreTag, type TurnLog } from './scoring.types';

const log = createLogger('judge-service');

const VALID_TAGS: ScoreTag[] = ['Perfect', 'Patched', 'Recovered', 'Rejected'];

/** Budget for the verdict-only retry: ample for the JSON object under a grammar that forbids prose. */
const RETRY_MAX_TOKENS = 400;

/** How much of a rambling first answer we feed back on retry (its tail holds the near-conclusion). */
const RETRY_ECHO_CHARS = 4000;

/**
 * Structured-output constraint for the retry pass. llama-server compiles this into a GBNF grammar and
 * constrains sampling of the content channel to it, so the judge physically cannot emit another
 * paragraph of deliberation. A nudge alone does not hold: a reasoning model handed its own truncated
 * CoT will happily start reasoning again.
 *
 * Must be paired with {@link NO_THINKING} — under a grammar alone this model simply diverts its
 * deliberation into the unconstrained `reasoning_content` channel and still burns the whole budget
 * before writing a single content token (verified against the configured llama-server).
 */
const VERDICT_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'verdict',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        tag: { type: 'string', enum: VALID_TAGS },
        explanation: { type: 'string' },
      },
      required: ['score', 'tag', 'explanation'],
      additionalProperties: false,
    },
  },
} as const;

/** Suppress the judge's thinking channel on the retry — the verdict is all we want tokens spent on. */
const NO_THINKING = { enable_thinking: false } as const;

/**
 * The LLM-as-judge for the Conversation Quality Scorer. Runs a single deterministic (temperature 0)
 * completion against the configured judge endpoint and parses a strict `{score, tag, explanation}`
 * verdict. Modelled on the title generator: resolve a dedicated endpoint (falling back to the fleet
 * default), one-shot `complete`, tolerant parsing. Returns null on any failure so callers skip the
 * turn rather than persist a bogus score.
 */
export const judgeService = {
  /** Resolve the judge inference target (dedicated endpoint → fleet default). */
  async resolveTarget(): Promise<{ target: ResolvedInference; maxTokens: number } | null> {
    const settings = await settingsService.get();
    let target: ResolvedInference | null = null;
    if (settings.scoring_endpoint_id) {
      target = await resolveForEndpoint(settings.scoring_endpoint_id, settings.scoring_model);
    }
    if (!target) {
      // Fleet default endpoint + its default model (no specific agent).
      target = await resolveInference({
        endpoint_id: null,
        model: settings.scoring_model || '',
      } as Pick<AgentDoc, 'endpoint_id' | 'model'>);
    }
    return target ? { target, maxTokens: settings.scoring_max_tokens } : null;
  },

  /** Score one assembled turn. Returns the verdict + the judge model id, or null on failure. */
  async judge(turn: TurnLog): Promise<{ verdict: JudgeVerdict; judgeModel: string } | null> {
    const resolved = await this.resolveTarget();
    if (!resolved) {
      log.warn('no judge endpoint resolvable — scoring skipped');
      return null;
    }
    const { target, maxTokens } = resolved;
    const messages: ChatMessage[] = [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: buildJudgeUserMessage(turn) },
    ];
    // Temperature 0 for reproducible scores. Tagged `source: 'judge'` so these calls are captured
    // but never re-scored (listRunIds only groups `chat-turn`; judge calls carry no run_id).
    const complete = (
      msgs: ChatMessage[],
      budget: number,
      constrained = false,
    ): Promise<string> =>
      runWithCaptureContext({ source: 'judge' }, () =>
        llamaClient.complete(target, msgs, {
          temperature: 0,
          maxTokens: budget,
          responseFormat: constrained ? VERDICT_RESPONSE_FORMAT : undefined,
          chatTemplateKwargs: constrained ? NO_THINKING : undefined,
        }),
      );

    try {
      const raw = await complete(messages, maxTokens);
      const first = parseVerdict(raw);
      if (first) return { verdict: first, judgeModel: target.model };

      // No verdict in the reply — almost always a reasoning model that deliberated past its token
      // budget (see JUDGE_RETRY_NUDGE). Hand it its own reasoning back and re-ask under a grammar that
      // admits nothing but the verdict object.
      log.debug(
        { runId: turn.runId, turnId: turn.turnId, agent: turn.agentName, chars: raw.length },
        'judge produced no parseable verdict — retrying under a verdict grammar',
      );
      const retry: ChatMessage[] = [
        ...messages,
        { role: 'assistant', content: raw.slice(-RETRY_ECHO_CHARS) },
        { role: 'user', content: JUDGE_RETRY_NUDGE },
      ];
      let rawRetry: string;
      try {
        rawRetry = await complete(retry, RETRY_MAX_TOKENS, true);
      } catch (err) {
        // The endpoint rejected `response_format` / `chat_template_kwargs` (not every OpenAI-ish
        // backend implements them). Fall back to an unconstrained retry — the nudge alone still
        // rescues the milder cases.
        log.debug(
          { runId: turn.runId, err: err instanceof Error ? err.message : String(err) },
          'constrained judge retry rejected by endpoint — retrying unconstrained',
        );
        rawRetry = await complete(retry, RETRY_MAX_TOKENS);
      }
      const second = parseVerdict(rawRetry);
      if (second) return { verdict: second, judgeModel: target.model };

      log.warn(
        {
          runId: turn.runId,
          turnId: turn.turnId,
          agent: turn.agentName,
          depth: turn.depth,
          preview: rawRetry.slice(0, 200),
        },
        'judge returned unparseable verdict twice — run left unscored',
      );
      return null;
    } catch (err) {
      log.warn(
        { runId: turn.runId, turnId: turn.turnId, err: err instanceof Error ? err.message : String(err) },
        'judge call failed',
      );
      return null;
    }
  },
};

/**
 * Parse + validate the judge's JSON verdict. Tolerant of a reasoning model that wraps the answer in
 * `<think>` or prose: strip the reasoning, take the LAST balanced JSON object that actually looks like
 * a verdict, coerce/clamp the score, validate the tag, and reconcile the score into its tag's band if
 * the model put them slightly out of sync.
 *
 * "Last, verdict-shaped" rather than "first": a deliberating judge quotes the response schema and
 * weighs candidate scores mid-reasoning, so the first `{...}` in the reply is regularly a hypothetical
 * (`{"score": <int 0-100>, ...}`) rather than the ruling it settles on.
 */
export function parseVerdict(raw: string): JudgeVerdict | null {
  const cleaned = stripReasoning(raw);
  // Scan every balanced object and keep the last one that parses into a valid verdict.
  let verdict: JudgeVerdict | null = null;
  for (const jsonStr of extractJsonObjects(cleaned)) {
    const candidate = toVerdict(jsonStr);
    if (candidate) verdict = candidate;
  }
  return verdict;
}

/** Validate one candidate JSON object as a verdict. Returns null if it isn't one. */
function toVerdict(jsonStr: string): JudgeVerdict | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  const tag = typeof obj.tag === 'string' ? (obj.tag as string) : '';
  if (!VALID_TAGS.includes(tag as ScoreTag)) return null;

  let score = typeof obj.score === 'number' ? Math.round(obj.score) : Number.parseInt(String(obj.score), 10);
  if (!Number.isFinite(score)) return null;
  score = Math.max(0, Math.min(100, score));

  // Keep score and tag consistent: if the model's number falls outside the tag's band, snap it to the
  // nearest edge of the band. The tag (a categorical judgment) is treated as authoritative.
  const [lo, hi] = SCORE_BANDS[tag as ScoreTag];
  if (score < lo) score = lo;
  if (score > hi) score = hi;

  const explanation = typeof obj.explanation === 'string' ? obj.explanation.slice(0, 400) : '';
  return { score, tag: tag as ScoreTag, explanation };
}

/**
 * Drop a reasoning model's `<think>` scratchpad. Handles the three shapes we see in the wild: a
 * closed block, a reply that opens `<think>` and is cut off by the token cap (nothing usable follows),
 * and a reply whose opening tag the server already ate so only the trailing `</think>` survives.
 */
function stripReasoning(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = s.lastIndexOf('</think>');
  if (close !== -1) s = s.slice(close + '</think>'.length);
  const open = s.search(/<think>/i);
  if (open !== -1) s = s.slice(0, open);
  return s.trim();
}

/** Every balanced `{...}` object in a string, in order (handles surrounding prose/fences). */
function extractJsonObjects(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      // A quote outside any object is prose, not the start of a JSON string.
      if (depth > 0) inStr = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) out.push(s.slice(start, i + 1));
    }
  }
  return out;
}
