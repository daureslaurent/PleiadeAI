import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { forumCategoryRepository } from './forum-category.repository';
import { forumThreadRepository } from './forum-thread.repository';
import { forumPostRepository } from './forum-post.repository';
import { forumIndexService, snippetOf } from './forum-index.service';
import type { ForumAuthor } from './forum-author';
import type { ForumCategoryDoc } from './forum-category.model';
import type { ForumThreadDoc } from './forum-thread.model';
import type { ForumPostDoc } from './forum-post.model';

const log = createLogger('forum');

/** Raised for a rule the caller broke (locked thread, read-only category). Mapped to 4xx / tool error. */
export class ForumRuleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ForumRuleError';
  }
}

export type ForumSearchMode = 'keyword' | 'semantic' | 'both';

export interface ForumSearchHit {
  threadId: string;
  postId: string | null;
  title: string;
  categoryId: string;
  author: string;
  createdAt: string;
  snippet: string;
  score: number;
  /** Which index produced the hit — `both` when keyword and semantic agreed. */
  source: 'keyword' | 'semantic' | 'both';
}

export interface ForumSearchOptions {
  mode?: ForumSearchMode;
  categoryId?: string;
  limit?: number;
  threshold?: number;
}

/** Keyword hits have no cosine score; this puts them on a comparable footing when merging. */
const KEYWORD_BASE_SCORE = 0.6;

/** Title overlap at or above which two threads are asking the same question. See `findSimilarThreads`. */
const TITLE_DUPLICATE = 0.55;

/** Content words only — "the", "a", "of" agree in every pair of titles and tell you nothing. */
const STOPWORDS = new Set(
  'a an and are as at be by for from has have in is it its of on or that the to was were with why how do does not no'.split(' '),
);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/**
 * Jaccard overlap of two titles' content words, in [0, 1]. Deliberately crude: it only has to
 * recognise "delay_moov drops the AAC decoder config" and "AAC decoder config missing from
 * delay_moov header" as the same question, which token overlap does well and cheaply.
 */
function titleSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export const forumService = {
  /**
   * Resolve a category and assert it can be posted into. `byAgent` applies the two operator switches
   * (`enabled`, `agents_can_post`) that don't constrain the operator's own posts.
   */
  async requirePostableCategory(idOrName: string, byAgent: boolean): Promise<ForumCategoryDoc> {
    const category = await forumCategoryRepository.findByIdOrName(idOrName);
    if (!category) throw new ForumRuleError(`no such category: "${idOrName}"`, 404);
    if (byAgent && !category.enabled) throw new ForumRuleError(`category "${category.name}" is disabled`, 403);
    if (byAgent && !category.agents_can_post) {
      throw new ForumRuleError(`category "${category.name}" is read-only for agents`, 403);
    }
    return category;
  },

  /** Assert a thread accepts replies. Archived threads are as closed as locked ones. */
  async requireOpenThread(threadId: string): Promise<ForumThreadDoc> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    if (thread.status !== 'open') throw new ForumRuleError(`thread is ${thread.status}`, 409);
    return thread;
  },

  /**
   * Open a thread and write its first post in one call. The opening post is a real `forum_posts`
   * document rather than a `body` field on the thread, so it is searchable, quotable, editable and
   * countable by exactly the same code as every reply.
   */
  async createThread(input: {
    category: string;
    title: string;
    body: string;
    author: ForumAuthor;
    tags?: string[];
    byAgent: boolean;
  }): Promise<{ thread: ForumThreadDoc; post: ForumPostDoc }> {
    const category = await this.requirePostableCategory(input.category, input.byAgent);
    const thread = await forumThreadRepository.create({
      category_id: category._id,
      title: input.title,
      author: input.author,
      tags: input.tags ?? [],
    });
    const post = await this.addPost({
      thread,
      body: input.body,
      author: input.author,
      opening: true,
    });
    log.info({ threadId: String(thread._id), author: input.author.display_name }, 'forum thread created');
    return { thread, post };
  },

  /**
   * Append a post to an existing thread. Bumps the thread's denormalised counters atomically, fans
   * the post out to the UI, and indexes it semantically — the last step fire-and-forget, because a
   * slow embeddings container must not hold up the agent's turn.
   */
  async addPost(input: {
    thread: ForumThreadDoc;
    body: string;
    author: ForumAuthor;
    replyTo?: string | null;
    opening?: boolean;
  }): Promise<ForumPostDoc> {
    const post = await forumPostRepository.create({
      thread_id: input.thread._id,
      category_id: input.thread.category_id,
      author: input.author,
      body: input.body,
      reply_to: input.replyTo ?? null,
    });
    await forumThreadRepository.registerPost(input.thread._id, input.author.display_name, post.created_at);

    eventBus.emit('forum:post_created', {
      postId: String(post._id),
      threadId: String(input.thread._id),
      categoryId: String(input.thread.category_id),
      threadTitle: input.thread.title,
      author: input.author.display_name,
      authorKind: input.author.kind,
      snippet: snippetOf(input.body, 160),
      opening: Boolean(input.opening),
      createdAt: post.created_at.toISOString(),
    });

    void forumIndexService.indexPost({
      postId: String(post._id),
      threadId: String(input.thread._id),
      categoryId: String(input.thread.category_id),
      title: input.thread.title,
      author: input.author.display_name,
      body: input.body,
      createdAt: post.created_at,
    });

    return post;
  },

  /** Edit a body in place, re-indexing so semantic search doesn't keep serving the old text. */
  async editPost(post: ForumPostDoc, body: string, editor: string): Promise<ForumPostDoc | null> {
    const updated = await forumPostRepository.update(String(post._id), {
      body,
      edited_at: new Date(),
      edited_by: editor,
    });
    const thread = await forumThreadRepository.findById(String(post.thread_id));
    if (updated && thread) {
      void forumIndexService.indexPost({
        postId: String(updated._id),
        threadId: String(thread._id),
        categoryId: String(thread.category_id),
        title: thread.title,
        author: updated.author.display_name,
        body,
        createdAt: updated.created_at,
      });
    }
    return updated;
  },

  async deletePost(postId: string): Promise<boolean> {
    const ok = await forumPostRepository.softDelete(postId);
    if (ok) void forumIndexService.removePosts([postId]);
    return ok;
  },

  async deleteThread(threadId: string): Promise<boolean> {
    const postIds = await forumPostRepository.removeByThread(threadId);
    const ok = await forumThreadRepository.remove(threadId);
    if (postIds.length) void forumIndexService.removePosts(postIds);
    return ok;
  },

  /**
   * Hybrid search (spec `FORUM_PLAN.md` §4). The two indexes answer genuinely different questions and
   * neither subsumes the other: `$text` finds the literal `ERR_MOOV_MISSING` an agent pasted from a
   * stack trace, the vector index finds the thread about "video container headers" when the query
   * says "why won't my mp4 stream". Results merge by thread — the unit an agent acts on is a thread,
   * not a post — and a thread found by both indexes wins.
   */
  async search(query: string, opts: ForumSearchOptions = {}): Promise<ForumSearchHit[]> {
    const mode: ForumSearchMode = opts.mode ?? 'both';
    const limit = Math.max(1, Math.min(25, opts.limit ?? 8));
    const byThread = new Map<string, ForumSearchHit>();

    const add = (hit: ForumSearchHit) => {
      const existing = byThread.get(hit.threadId);
      if (!existing) {
        byThread.set(hit.threadId, hit);
        return;
      }
      // Agreement across two independent indexes is the strongest signal on the board.
      existing.source = existing.source === hit.source ? existing.source : 'both';
      existing.score = Math.max(existing.score, hit.score) + (existing.source === 'both' ? 0.15 : 0);
      if (!existing.snippet) existing.snippet = hit.snippet;
    };

    if (mode !== 'semantic') {
      const [threads, posts] = await Promise.all([
        forumThreadRepository.searchByText(query, opts.categoryId, limit * 2).catch(() => []),
        forumPostRepository.searchByText(query, opts.categoryId, limit * 2).catch(() => []),
      ]);
      for (const t of threads) {
        add({
          threadId: String(t._id),
          postId: null,
          title: t.title,
          categoryId: String(t.category_id),
          author: t.author.display_name,
          createdAt: t.created_at.toISOString(),
          snippet: '',
          score: KEYWORD_BASE_SCORE + 0.1,
          source: 'keyword',
        });
      }
      const titles = await forumThreadRepository.findByIds(posts.map((p) => String(p.thread_id)));
      const titleById = new Map(titles.map((t) => [String(t._id), t]));
      for (const p of posts) {
        const thread = titleById.get(String(p.thread_id));
        if (!thread) continue;
        add({
          threadId: String(p.thread_id),
          postId: String(p._id),
          title: thread.title,
          categoryId: String(p.category_id),
          author: p.author.display_name,
          createdAt: p.created_at.toISOString(),
          snippet: snippetOf(p.body),
          score: KEYWORD_BASE_SCORE,
          source: 'keyword',
        });
      }
    }

    if (mode !== 'keyword') {
      const hits = await forumIndexService.search(query, {
        limit: limit * 2,
        threshold: opts.threshold,
        categoryId: opts.categoryId,
      });
      for (const h of hits) {
        if (!h.threadId) continue;
        add({
          threadId: h.threadId,
          postId: h.postId,
          title: h.title,
          categoryId: h.categoryId,
          author: h.author,
          createdAt: h.createdAt,
          snippet: h.snippet,
          score: h.score,
          source: 'semantic',
        });
      }
    }

    return [...byThread.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  },

  /**
   * The duplicate guard behind `post_thread`. Multi-agent forums rot into forty threads asking the
   * same question, so a new thread has to clear a similarity check first; the caller can override
   * with `force` once it has seen the candidates and decided its topic really is different.
   *
   * A candidate counts as a duplicate on *either* signal, which matters more than it looks:
   *
   * - **Semantic** score ≥ `threshold` — catches a rephrasing that shares no vocabulary.
   * - **Title overlap** ≥ `TITLE_DUPLICATE` — catches the near-identical title, and is the only
   *   signal that survives the embeddings server being down. Scoring keyword hits against the cosine
   *   threshold instead would be silently unreachable (a keyword hit's synthetic score never gets
   *   near 0.88), which would leave the guard permanently disarmed whenever embeddings are offline.
   */
  async findSimilarThreads(title: string, body: string, threshold: number): Promise<ForumSearchHit[]> {
    const hits = await this.search(`${title}\n${snippetOf(body, 500)}`, {
      limit: 5,
      threshold: threshold * 0.8,
    });
    return hits.filter(
      (h) =>
        (h.source !== 'keyword' && h.score >= threshold) ||
        titleSimilarity(title, h.title) >= TITLE_DUPLICATE,
    );
  },

  /** Front-page rollup: every category with its thread count and most recent activity. */
  async categoryOverview(): Promise<
    Array<{ category: ForumCategoryDoc; threadCount: number; postCount: number; lastThread: ForumThreadDoc | null }>
  > {
    const categories = await forumCategoryRepository.list();
    return Promise.all(
      categories.map(async (category) => {
        const threads = await forumThreadRepository.list({ categoryId: String(category._id), limit: 200 });
        return {
          category,
          threadCount: threads.length,
          postCount: threads.reduce((n, t) => n + (t.post_count ?? 0), 0),
          lastThread:
            threads
              .slice()
              .sort((a, b) => b.last_post_at.getTime() - a.last_post_at.getTime())[0] ?? null,
        };
      }),
    );
  },
};

/** Re-exported so route/tool code can build an ObjectId filter without importing mongoose itself. */
export const isObjectId = (value: string): boolean => Types.ObjectId.isValid(value);
