import { randomUUID } from 'node:crypto';
import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { qdrantService, type MemoryPoint } from './qdrant.service';

const log = createLogger('agent-memory');

/** Skip retrieval entirely for trivially short queries (greetings, "ok", etc.). */
const MIN_QUERY_CHARS = 3;

/**
 * High-level vector memory for an agent, layering embeddings over the isolated Qdrant namespace.
 * Every method is best-effort: if the embeddings service is down or a query fails it logs and
 * returns an empty/no-op result so a memory hiccup never breaks the agent's turn.
 */
export const agentMemory = {
  /** Embed `text` and persist it into the agent's namespace. Returns the new point id, or null. */
  async remember(
    namespace: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string | null> {
    const content = text.trim();
    if (!content) return null;
    try {
      const vector = await llamaClient.embed(content);
      const id = randomUUID();
      await qdrantService.upsert(namespace, [
        { id, vector, payload: { text: content, ...metadata, created_at: new Date().toISOString() } },
      ]);
      return id;
    } catch (err) {
      log.warn({ namespace, err: err instanceof Error ? err.message : String(err) }, 'remember failed');
      return null;
    }
  },

  /** Embed `query` and return the most similar memories from the agent's namespace. */
  async recall(namespace: string, query: string, limit = 5): Promise<MemoryPoint[]> {
    if (query.trim().length < MIN_QUERY_CHARS) return [];
    try {
      const vector = await llamaClient.embed(query);
      return await qdrantService.search(namespace, vector, limit);
    } catch (err) {
      log.warn({ namespace, err: err instanceof Error ? err.message : String(err) }, 'recall failed');
      return [];
    }
  },
};
