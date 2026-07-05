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

  async search(namespace: string, vector: number[], limit = 5): Promise<MemoryPoint[]> {
    const { exists } = await this.client.collectionExists(namespace);
    if (!exists) return [];
    const results = await this.client.search(namespace, { vector, limit, with_payload: true });
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: (r.payload ?? {}) as Record<string, unknown>,
    }));
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
