import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('model-size');

export interface ResolvedSize {
  size_b: number;
  source: 'provided' | 'name' | 'hf_config_estimate';
}

/**
 * Resolve a base model's parameter count in billions. Cheapest-first:
 *   1. `target_size_b` asserted by the caller,
 *   2. a `<n>B` token in the model name (offline, covers most real HF ids),
 *   3. an estimate from the model's HF `config.json` (best-effort network fetch).
 * Throws if none succeed so the caller can ask the app to pass `target_size_b`.
 */
export async function resolveModelSizeB(
  baseModel: string,
  targetSizeB?: number,
): Promise<ResolvedSize> {
  if (targetSizeB && targetSizeB > 0) {
    return { size_b: targetSizeB, source: 'provided' };
  }

  const fromName = parseSizeFromName(baseModel);
  if (fromName) return { size_b: fromName, source: 'name' };

  const fromConfig = await estimateSizeFromHfConfig(baseModel);
  if (fromConfig) return { size_b: fromConfig, source: 'hf_config_estimate' };

  throw new Error(
    `could not determine parameter count for "${baseModel}"; pass target_size_b explicitly`,
  );
}

/** Match tokens like `14B`, `7b`, `1.5B`, `Qwen2.5-14B-Instruct`. Ignores the `2.5`-style prefix. */
export function parseSizeFromName(name: string): number | null {
  // Prefer a number immediately followed by B/b at a token boundary.
  const matches = [...name.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)];
  if (matches.length === 0) return null;
  // If several (rare), take the largest — usually the true size.
  const values = matches.map((m) => Number(m[1])).filter((v) => v > 0 && v < 2000);
  return values.length ? Math.max(...values) : null;
}

/**
 * Rough transformer param count from an HF `config.json`. Approximate (ignores GQA KV
 * reduction, bias terms) but good enough to pick a fitting envelope. Best-effort: any
 * network/parse failure returns null.
 */
async function estimateSizeFromHfConfig(baseModel: string): Promise<number | null> {
  const url = `https://huggingface.co/${baseModel}/resolve/main/config.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : undefined,
    });
    if (!res.ok) {
      log.warn({ baseModel, status: res.status }, 'HF config fetch non-2xx');
      return null;
    }
    const cfg = (await res.json()) as Record<string, number | boolean | undefined>;
    const h = num(cfg.hidden_size);
    const layers = num(cfg.num_hidden_layers);
    const vocab = num(cfg.vocab_size);
    if (!h || !layers || !vocab) return null;
    const inter = num(cfg.intermediate_size) ?? 4 * h;

    const embed = vocab * h;
    const tied = cfg.tie_word_embeddings === true;
    const attnPerLayer = 4 * h * h; // q,k,v,o projections (upper bound, ignores GQA)
    const mlpPerLayer = 3 * h * inter; // gated MLP (gate, up, down)
    const params = embed + layers * (attnPerLayer + mlpPerLayer) + (tied ? 0 : vocab * h);

    const sizeB = params / 1e9;
    log.info({ baseModel, sizeB: Number(sizeB.toFixed(2)) }, 'estimated size from HF config');
    return sizeB;
  } catch (err) {
    log.warn({ baseModel, err: (err as Error).message }, 'HF config estimate failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
