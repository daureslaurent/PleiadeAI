import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { runWithCaptureContext } from '../../inference/capture-context';
import { resolveInference, resolveForEndpoint, type ResolvedInference } from '../../inference/inference-resolver';
import { settingsService } from '../settings/settings.service';
import type { AgentDoc } from '../agents/agent.model';
import type { ChatMessage } from '../agents/jit-builder';
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserMessage } from './judge-prompt';
import { SCORE_BANDS, type JudgeVerdict, type ScoreTag, type TurnLog } from './scoring.types';

const log = createLogger('judge-service');

const VALID_TAGS: ScoreTag[] = ['Perfect', 'Patched', 'Recovered', 'Rejected'];

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
    try {
      // Temperature 0 for reproducible scores. Tagged `source: 'judge'` so these calls are captured
      // but never re-scored (listRunIds only groups `chat-turn`; judge calls carry no run_id).
      const raw = await runWithCaptureContext({ source: 'judge' }, () =>
        llamaClient.complete(target, messages, { temperature: 0, maxTokens }),
      );
      const verdict = parseVerdict(raw);
      if (!verdict) {
        log.warn({ turnId: turn.turnId, preview: raw.slice(0, 200) }, 'judge returned unparseable verdict');
        return null;
      }
      return { verdict, judgeModel: target.model };
    } catch (err) {
      log.warn({ turnId: turn.turnId, err: err instanceof Error ? err.message : String(err) }, 'judge call failed');
      return null;
    }
  },
};

/**
 * Parse + validate the judge's JSON verdict. Tolerant of a reasoning model that wraps the answer in
 * `<think>` or prose: extract the first balanced JSON object, coerce/clamp the score, validate the tag,
 * and reconcile the score into its tag's band if the model put them slightly out of sync.
 */
export function parseVerdict(raw: string): JudgeVerdict | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const jsonStr = extractJsonObject(cleaned);
  if (!jsonStr) return null;
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

/** Extract the first balanced `{...}` object from a string (handles surrounding prose/fences). */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
