import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';

const log = createLogger('qdrant');

/**
 * Vector memory with **strict per-agent isolation** (spec §3, §5). Each agent owns exactly
 * one Qdrant collection named by its `qdrant_namespace`; there is no cross-agent read/write
 * path. All public methods take a namespace and operate only within it.
 */

export interface MemoryPoint {
  id: string | number;
  score?: number;
  payload: Record<string, unknown>;
  /** Only populated by `search` when `withVector` is set (needed for MMR diversity filtering). */
  vector?: number[];
}

export interface SearchOptions {
  limit?: number;
  /**
   * Minimum cosine similarity. **Load-bearing**: without it Qdrant happily returns its top-N no
   * matter how irrelevant, and since unrelated normalized embeddings still score ~0.3+, every
   * single query came back "full" of noise that was then injected as "relevant memories".
   */
  scoreThreshold?: number;
  /** Restrict to points whose payload matches (e.g. `{ kind: 'fact' }`). */
  filter?: Record<string, string>;
  /**
   * Exclude points whose payload matches (e.g. `{ status: 'superseded' }`). Prefer this over a
   * positive `status: 'active'` filter: a point written before the field existed carries no
   * `status` at all, and Qdrant's `must` would drop it — an exclusion keeps legacy memories
   * readable while still retiring the ones explicitly marked.
   */
  mustNot?: Record<string, string>;
  withVector?: boolean;
}

const DEFAULT_VECTOR_SIZE = 768; // llama.cpp embedding dimension; override per deployment.

class QdrantService {
  private readonly client = new QdrantClient({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
  });

  /** Idempotently ensure an agent's isolated collection exists. */
  async ensureNamespace(namespace: string, vectorSize = DEFAULT_VECTOR_SIZE): Promise<void> {
    const { exists } = await this.client.collectionExists(namespace);
    if (exists) return;
    await this.client.createCollection(namespace, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
    log.info({ namespace, vectorSize }, 'qdrant namespace created');
  }

  async upsert(
    namespace: string,
    points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }>,
  ): Promise<void> {
    await this.ensureNamespace(namespace, points[0]?.vector.length ?? DEFAULT_VECTOR_SIZE);
    await this.client.upsert(namespace, { wait: true, points });
  }

  async search(namespace: string, vector: number[], opts: SearchOptions = {}): Promise<MemoryPoint[]> {
    const { exists } = await this.client.collectionExists(namespace);
    if (!exists) return [];
    const clause = (entries: Record<string, string>) =>
      Object.entries(entries).map(([key, value]) => ({ key, match: { value } }));
    const filter =
      opts.filter || opts.mustNot
        ? {
            ...(opts.filter ? { must: clause(opts.filter) } : {}),
            ...(opts.mustNot ? { must_not: clause(opts.mustNot) } : {}),
          }
        : undefined;
    const results = await this.client.search(namespace, {
      vector,
      limit: opts.limit ?? 5,
      score_threshold: opts.scoreThreshold,
      filter,
      with_payload: true,
      with_vector: opts.withVector ?? false,
    });
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      vector: Array.isArray(r.vector) ? (r.vector as number[]) : undefined,
    }));
  }

  /**
   * Merge fields into an existing point's payload, leaving the vector untouched. This is what lets a
   * memory be reinforced (usage/importance bumps) or retired (`status: 'superseded'`) without
   * re-embedding it. Missing point → Qdrant no-ops rather than throwing.
   */
  async setPayload(
    namespace: string,
    id: string | number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { exists } = await this.client.collectionExists(namespace);
    if (!exists) return;
    await this.client.setPayload(namespace, { wait: false, payload, points: [id] });
  }

  /** Inspector listing for the Memory Vault UI (scroll, no vector query). */
  async list(namespace: string, limit = 100): Promise<MemoryPoint[]> {
    const { exists } = await this.client.collectionExists(namespace);
    if (!exists) return [];
    const res = await this.client.scroll(namespace, { limit, with_payload: true, with_vector: false });
    return res.points.map((p) => ({
      id: p.id,
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * Full dump of a namespace (vectors + payload) for backup/export. Pages through every point via
   * `scroll`; returns the collection's vector size so an archive is self-describing. Missing
   * collection → empty. Read-only, and still strictly single-namespace like every other method.
   */
  async exportNamespace(
    namespace: string,
  ): Promise<{ vector_size: number; points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }> }> {
    const { exists } = await this.client.collectionExists(namespace);
    if (!exists) return { vector_size: DEFAULT_VECTOR_SIZE, points: [] };

    const info = await this.client.getCollection(namespace);
    const vectors = info.config?.params?.vectors;
    const vector_size =
      typeof vectors === 'object' && vectors && 'size' in vectors ? Number(vectors.size) : DEFAULT_VECTOR_SIZE;

    const points: Array<{ id: string | number; vector: number[]; payload: Record<string, unknown> }> = [];
    let offset: string | number | undefined | null;
    do {
      const res = await this.client.scroll(namespace, {
        limit: 256,
        with_payload: true,
        with_vector: true,
        offset: offset ?? undefined,
      });
      for (const p of res.points) {
        points.push({
          id: p.id,
          vector: Array.isArray(p.vector) ? (p.vector as number[]) : [],
          payload: (p.payload ?? {}) as Record<string, unknown>,
        });
      }
      offset = res.next_page_offset as string | number | null | undefined;
    } while (offset !== null && offset !== undefined);

    return { vector_size, points };
  }

  /** Explicit deletion of corrupted memories (Memory Vault delete action). */
  async deletePoints(namespace: string, ids: Array<string | number>): Promise<void> {
    await this.client.delete(namespace, { wait: true, points: ids });
    log.info({ namespace, count: ids.length }, 'qdrant points deleted');
  }
}

export const qdrantService = new QdrantService();
