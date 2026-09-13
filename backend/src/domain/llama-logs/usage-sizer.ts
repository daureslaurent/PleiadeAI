import { llamaClient } from '../../inference/LlamaClient';
import type { ResolvedInference } from '../../inference/inference-resolver';
import type { ChatMessage } from '../agents/jit-builder';
import {
  foldSegments,
  groupByModule,
  planUsagePieces,
  promptModules,
  type PromptUsageBreakdown,
} from './prompt-usage';

/**
 * Weigh one prompt: plan its pieces (`prompt-usage.ts` decides *what* the rows are), size them in a
 * single bounded-concurrency tokenize pass, and fold them into the breakdown the **Usage** tab draws.
 *
 * This is the one place that does it. `AgentRunner` calls it live, on every inference pass, so the
 * tab moves with the turn; `POST /llama-logs/usage-breakdown` calls it for a *captured* call, which
 * is how a session opened long after its last turn still gets a breakdown. Both must produce the
 * same rows for the same prompt or the panel would appear to change its mind when a turn ends.
 *
 * `knownTotal` skips the exact `/apply-template` + `/tokenize` round trip when the caller already
 * holds the server's own prompt-token count for *these* messages (the live path: the pass that just
 * ran reported it). Pass `null`/omit and the total is measured.
 */
export async function sizePrompt(
  target: ResolvedInference,
  messages: unknown[],
  tools: unknown[] | undefined,
  knownTotal?: number | null,
): Promise<PromptUsageBreakdown> {
  if (!messages.length) {
    return {
      segments: [],
      moduleGroups: [],
      sum: 0,
      total: 0,
      contextWindow: target.contextWindow,
      modules: [],
    };
  }

  const pieces = planUsagePieces(messages, tools);
  const [counts, total] = await Promise.all([
    llamaClient.tokenizeTexts(target, pieces.map((p) => p.text)),
    knownTotal != null
      ? Promise.resolve(knownTotal)
      : llamaClient.tokenizeMessages(target, messages as ChatMessage[], tools).catch(() => null),
  ]);
  const segments = foldSegments(pieces, counts);
  return {
    segments,
    moduleGroups: groupByModule(segments),
    sum: segments.reduce((a, s) => a + (s.tokens ?? 0), 0),
    total,
    contextWindow: target.contextWindow,
    modules: promptModules(messages),
  };
}
