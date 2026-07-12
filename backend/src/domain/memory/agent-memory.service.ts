import { randomUUID } from 'node:crypto';
import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { qdrantService, type MemoryPoint } from './qdrant.service';
import {
  MAX_IMPORTANCE,
  normalizePayload,
  type MemoryKind,
  type MemoryPayload,
  type MemorySource,
  type RecalledMemory,
} from './memory.types';

const log = createLogger('agent-memory');

/** Skip retrieval entirely for trivially short queries (greetings, "ok", etc.). */
const MIN_QUERY_CHARS = 3;

/**
 * Retrieval tuning (spec: `docs/memory-souvenirs.md`).
 *
 * The old reader had none of this: a bare top-5 cosine with no floor. Because unrelated normalized
 * embeddings still score ~0.3+, it injected five "relevant memories" on *every* turn, relevant or
 * not. The floor is what makes recall able to return nothing.
 */
const RECALL = {
  /** Cosine floor. Below this a memory is not about the query, whatever its rank. */
  THRESHOLD: 0.55,
  /** Candidates pulled before reranking — over-fetch, then earn the slot. */
  OVERFETCH: 20,
  /** How many survive into the prompt. */
  LIMIT: 5,
  /** Total characters of memory allowed into the prompt. Keeps recall from crowding out the turn. */
  CHAR_BUDGET: 1200,
  /** A candidate this close to one already picked adds nothing but tokens (MMR). */
  MMR_DUPLICATE: 0.9,
  /** Days after which a memory's recency contribution has halved. */
  RECENCY_HALF_LIFE_DAYS: 30,
  /** Composite rerank weights; must sum to 1. */
  W_SIMILARITY: 0.55,
  W_RECENCY: 0.2,
  W_IMPORTANCE: 0.15,
  W_USAGE: 0.1,
} as const;

/** Similarity at or above which a new memory is the *same* memory — reinforce, don't duplicate. */
export const DEDUP_THRESHOLD = 0.93;

/** Usage saturates: the difference between 0 and 5 recalls matters, 50 vs 55 doesn't. */
const USAGE_SATURATION = 10;

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Exponential decay on age, in [0, 1]. A memory written today scores 1, one half-life ago 0.5. */
function recencyScore(createdAt: string): number {
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.pow(0.5, ageDays / RECALL.RECENCY_HALF_LIFE_DAYS);
}

/**
 * Composite rerank. Similarity still dominates, but a memory that is recent, that the agent marked
 * important, or that has repeatedly proven useful when recalled, outranks an equally-similar one
 * that is stale, trivial and never used. This is the "scoring" half of the redesign — pure cosine
 * has no way to tell a load-bearing fact from a passing remark that happens to share vocabulary.
 */
function rerankScore(payload: MemoryPayload, similarity: number): number {
  const importance = (payload.importance - 1) / (MAX_IMPORTANCE - 1); // → [0,1]
  const usage = Math.min(1, payload.recall_count / USAGE_SATURATION);
  return (
    RECALL.W_SIMILARITY * similarity +
    RECALL.W_RECENCY * recencyScore(payload.created_at) +
    RECALL.W_IMPORTANCE * importance +
    RECALL.W_USAGE * usage
  );
}

export interface RememberInput {
  text: string;
  kind?: MemoryKind;
  subject?: string;
  importance?: number;
  tags?: string[];
  source?: MemorySource;
  sessionId?: string;
  turnId?: string;
}

/**
 * High-level vector memory for an agent, layering embeddings over the isolated Qdrant namespace.
 * Every method is best-effort: if the embeddings service is down or a query fails it logs and
 * returns an empty/no-op result so a memory hiccup never breaks the agent's turn.
 */
export const agentMemory = {
  /**
   * Embed `text` and persist it as a typed souvenir. Deduplicates first: if the namespace already
   * holds an effectively identical memory, that one is **reinforced** (usage + importance bump)
   * and no twin is written — this is what stops the vault filling with five copies of the same
   * fact after the same question is asked five times.
   */
  async remember(namespace: string, input: RememberInput): Promise<string | null> {
    const content = input.text.trim();
    if (!content) return null;
    try {
      const vector = await llamaClient.embed(content);

      const [nearest] = await qdrantService.search(namespace, vector, {
        limit: 1,
        scoreThreshold: DEDUP_THRESHOLD,
        mustNot: { status: 'superseded' },
      });
      if (nearest) {
        await this.reinforce(namespace, nearest, input.importance);
        return String(nearest.id);
      }

      const id = randomUUID();
      const payload: MemoryPayload = {
        text: content,
        kind: input.kind ?? 'episode',
        subject: input.subject?.trim() ?? '',
        importance: Math.min(MAX_IMPORTANCE, Math.max(1, input.importance ?? 2)),
        tags: input.tags ?? [],
        source: input.source ?? 'distiller',
        status: 'active',
        superseded_by: null,
        created_at: new Date().toISOString(),
        last_recalled_at: null,
        recall_count: 0,
        reinforced_count: 0,
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.turnId ? { turn_id: input.turnId } : {}),
      };
      await qdrantService.upsert(namespace, [
        { id, vector, payload: payload as unknown as Record<string, unknown> },
      ]);
      return id;
    } catch (err) {
      log.warn({ namespace, err: err instanceof Error ? err.message : String(err) }, 'remember failed');
      return null;
    }
  },

  /**
   * Recall for a query: over-fetch above a similarity floor, rerank on the composite score, drop
   * near-duplicates (MMR), and cut to a character budget. Returns [] when nothing clears the floor
   * — an agent with no relevant memories should get *no* memory block, not five bad ones.
   *
   * Injected memories are reinforced on the way out (fire-and-forget), so what keeps proving useful
   * keeps winning slots.
   */
  async recall(namespace: string, query: string, limit: number = RECALL.LIMIT): Promise<RecalledMemory[]> {
    if (query.trim().length < MIN_QUERY_CHARS) return [];
    try {
      const vector = await llamaClient.embed(query);
      const candidates = await qdrantService.search(namespace, vector, {
        limit: RECALL.OVERFETCH,
        scoreThreshold: RECALL.THRESHOLD,
        mustNot: { status: 'superseded' },
        withVector: true,
      });
      if (!candidates.length) return [];

      const ranked = candidates
        .map((c) => {
          const payload = normalizePayload(c.payload);
          const similarity = c.score ?? 0;
          return { id: c.id, payload, similarity, score: rerankScore(payload, similarity), vector: c.vector };
        })
        .filter((c) => c.payload.text)
        .sort((a, b) => b.score - a.score);

      const selected: Array<(typeof ranked)[number]> = [];
      let chars = 0;
      for (const cand of ranked) {
        if (selected.length >= limit) break;
        // MMR: a near-clone of something already selected costs tokens and adds no information.
        const redundant = selected.some(
          (s) =>
            s.vector &&
            cand.vector &&
            cosine(s.vector, cand.vector) >= RECALL.MMR_DUPLICATE,
        );
        if (redundant) continue;
        if (chars + cand.payload.text.length > RECALL.CHAR_BUDGET && selected.length) break;
        selected.push(cand);
        chars += cand.payload.text.length;
      }

      void this.markRecalled(namespace, selected);

      return selected.map(({ id, payload, similarity, score }) => ({ id, payload, similarity, score }));
    } catch (err) {
      log.warn({ namespace, err: err instanceof Error ? err.message : String(err) }, 'recall failed');
      return [];
    }
  },

  /** Bump usage counters on the memories that actually made it into a prompt. Never throws. */
  async markRecalled(
    namespace: string,
    memories: Array<{ id: string | number; payload: MemoryPayload }>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await Promise.all(
      memories.map((m) =>
        qdrantService
          .setPayload(namespace, m.id, {
            recall_count: m.payload.recall_count + 1,
            last_recalled_at: now,
          })
          .catch(() => undefined),
      ),
    );
  },

  /**
   * Collapse a re-derived duplicate into the memory that already holds it: count the reinforcement
   * and let repeated derivation raise importance (something the agent keeps concluding matters),
   * capped so it can't run away.
   */
  async reinforce(namespace: string, existing: MemoryPoint, importance?: number): Promise<void> {
    const payload = normalizePayload(existing.payload);
    await qdrantService
      .setPayload(namespace, existing.id, {
        reinforced_count: payload.reinforced_count + 1,
        importance: Math.min(MAX_IMPORTANCE, Math.max(payload.importance, importance ?? 0) + 1),
      })
      .catch(() => undefined);
    log.debug({ namespace, id: existing.id }, 'memory reinforced (duplicate collapsed)');
  },

  /**
   * Retire a memory: kept in the namespace for audit, never recalled again. This is how a stated
   * fact gets *corrected* rather than left to contradict its replacement forever.
   */
  async supersede(namespace: string, id: string, supersededBy: string | null = null): Promise<void> {
    await qdrantService
      .setPayload(namespace, id, { status: 'superseded', superseded_by: supersededBy })
      .catch((err) => log.warn({ namespace, id, err: String(err) }, 'supersede failed'));
  },
};
