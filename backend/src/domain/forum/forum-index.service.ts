import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { qdrantService } from '../memory/qdrant.service';

const log = createLogger('forum-index');

/**
 * The forum's **semantic** index — the second half of hybrid search (spec `FORUM_PLAN.md` §4).
 *
 * ## Why this is a separate, shared Qdrant collection
 *
 * `qdrant.service.ts` opens by stating that vector memory has *strict per-agent isolation* and that
 * "there is no cross-agent read/write path". That invariant is about **memory**, and it is unchanged:
 * no forum point is ever written into an agent's `qdrant_namespace`, and nothing here reads one.
 *
 * A forum, however, is cross-agent *by definition* — a knowledge base only one agent can read is just
 * memory with extra steps. So the forum gets its own collection, sitting beside the memory namespaces
 * rather than inside one. The two stores stay structurally distinct: memory is private and implicit
 * (auto-recalled), the forum is public and explicit (only ever reached by a deliberate `forum search`).
 *
 * ## Degradation
 *
 * Every method swallows its own failures. The embeddings server is a separate CPU container that can
 * be down or slow, and a forum post must never fail to save because a vector couldn't be computed —
 * the Mongo `$text` index still answers keyword queries, so search degrades rather than breaks.
 */
const FORUM_NAMESPACE = 'forum_index';

/** What a hit carries back. Snippets only — full bodies are fetched deliberately via `read_thread`. */
export interface ForumIndexHit {
  postId: string;
  threadId: string;
  categoryId: string;
  title: string;
  author: string;
  createdAt: string;
  snippet: string;
  score: number;
}

/** Embedding input is capped: a 40 KB post would blow the embedding server's context for no gain. */
const MAX_EMBED_CHARS = 4000;
/** How much of a post the index carries for display. The rest is one `read_thread` away. */
const SNIPPET_CHARS = 320;

/**
 * Qdrant only accepts a UUID or an unsigned integer as a point id — a 24-character ObjectId hex
 * string is rejected outright. A Mongo id is 12 bytes and a UUID is 16, so zero-padding the hex to 32
 * characters and inserting the dashes gives a valid, collision-free, *deterministic* point id. It has
 * to be deterministic rather than a fresh `randomUUID()` (which is what agent memory uses) because an
 * edited post must overwrite its own vector, and a deleted one must be findable to remove.
 */
function pointIdFor(postId: string): string {
  const hex = postId.replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function snippetOf(body: string, chars = SNIPPET_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= chars ? flat : `${flat.slice(0, chars)}…`;
}

export interface IndexPostInput {
  postId: string;
  threadId: string;
  categoryId: string;
  title: string;
  author: string;
  body: string;
  createdAt: Date;
}

export const forumIndexService = {
  /**
   * Index (or re-index) a post. The embedded text is `title + body`: a reply that says only "agreed,
   * and the fix is `-movflags +faststart`" is meaningless without the question it answers, and
   * without the title it would never match a query phrased around the topic.
   */
  async indexPost(input: IndexPostInput): Promise<void> {
    try {
      const text = `${input.title}\n\n${input.body}`.slice(0, MAX_EMBED_CHARS);
      const vector = await llamaClient.embed(text);
      await qdrantService.upsert(FORUM_NAMESPACE, [
        {
          id: pointIdFor(input.postId),
          vector,
          payload: {
            post_id: input.postId,
            thread_id: input.threadId,
            category_id: input.categoryId,
            title: input.title,
            author: input.author,
            created_at: input.createdAt.toISOString(),
            snippet: snippetOf(input.body),
          },
        },
      ]);
    } catch (err) {
      log.warn({ err, postId: input.postId }, 'forum post not indexed — semantic search will miss it');
    }
  },

  /** Semantic search across the whole board, optionally scoped to one category. */
  async search(
    query: string,
    opts: { limit?: number; threshold?: number; categoryId?: string } = {},
  ): Promise<ForumIndexHit[]> {
    try {
      const vector = await llamaClient.embed(query.slice(0, MAX_EMBED_CHARS));
      return await this.searchByVector(vector, opts);
    } catch (err) {
      log.warn({ err }, 'forum semantic search unavailable — falling back to keyword only');
      return [];
    }
  },

  /**
   * The same search against a vector the caller already has. Split out so a turn that has already
   * embedded its query for memory recall can search the board without paying to embed the identical
   * text a second time (see `forum-recall.service.ts`).
   */
  async searchByVector(
    vector: number[],
    opts: { limit?: number; threshold?: number; categoryId?: string } = {},
  ): Promise<ForumIndexHit[]> {
    const points = await qdrantService.search(FORUM_NAMESPACE, vector, {
      limit: opts.limit ?? 8,
      // Without a floor Qdrant returns its top-N however irrelevant; see qdrant.service.ts.
      scoreThreshold: opts.threshold ?? 0.45,
      filter: opts.categoryId ? { category_id: opts.categoryId } : undefined,
    });
    return points.map((p) => ({
      postId: String(p.payload.post_id ?? p.id),
      threadId: String(p.payload.thread_id ?? ''),
      categoryId: String(p.payload.category_id ?? ''),
      title: String(p.payload.title ?? ''),
      author: String(p.payload.author ?? ''),
      createdAt: String(p.payload.created_at ?? ''),
      snippet: String(p.payload.snippet ?? ''),
      score: p.score ?? 0,
    }));
  },

  async removePosts(postIds: string[]): Promise<void> {
    if (!postIds.length) return;
    try {
      await qdrantService.deletePoints(FORUM_NAMESPACE, postIds.map(pointIdFor));
    } catch (err) {
      log.warn({ err, count: postIds.length }, 'forum posts not de-indexed');
    }
  },
};
