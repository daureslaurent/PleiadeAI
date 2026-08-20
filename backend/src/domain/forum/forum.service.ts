import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import { forumCategoryRepository } from './forum-category.repository';
import { forumThreadRepository } from './forum-thread.repository';
import { forumPostRepository } from './forum-post.repository';
import { forumFileRepository } from './forum-file.repository';
import { forumIndexService, snippetOf } from './forum-index.service';
import { forumMentionService } from './forum-mention.service';
import { forumMentionRepository } from './forum-mention.repository';
import type { ForumAuthor } from './forum-author';
import type { ForumCategoryDoc } from './forum-category.model';
import type { ForumThreadDoc, ForumWorkState } from './forum-thread.model';
import type { ForumPostDoc } from './forum-post.model';
import type { ForumFileDoc } from './forum-file.model';

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

/**
 * Resolve attachment ids into live registry files, refusing the whole post if any of them is bogus.
 *
 * Strict on purpose: a post that silently dropped the file it was written to explain is worse than a
 * failed call the agent can retry, and the author is the only party who still knows what the missing
 * id was meant to be.
 */
async function resolveAttachments(ids: string[] | undefined): Promise<ForumFileDoc[]> {
  const wanted = (ids ?? []).map((id) => String(id).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const files = await forumFileRepository.findByIds(wanted);
  if (files.length !== wanted.length) {
    const found = new Set(files.map((f) => String(f._id)));
    const missing = wanted.filter((id) => !found.has(id));
    throw new ForumRuleError(`unknown attachment id(s): ${missing.join(', ')}`, 404);
  }
  return files;
}

/** The text fed to both indexes for a post's files. Names only — bytes never enter search. */
function attachmentNames(files: ForumFileDoc[]): string {
  return files.map((f) => f.filename).join(' ');
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
    attachments?: string[];
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
      attachments: input.attachments,
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
    attachments?: string[];
    opening?: boolean;
  }): Promise<ForumPostDoc> {
    const files = await resolveAttachments(input.attachments);
    const post = await forumPostRepository.create({
      thread_id: input.thread._id,
      category_id: input.thread.category_id,
      author: input.author,
      body: input.body,
      reply_to: input.replyTo ?? null,
      attachments: files.map((f) => f._id),
      attachment_names: attachmentNames(files),
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
      attachmentCount: files.length,
      opening: Boolean(input.opening),
      createdAt: post.created_at.toISOString(),
    });

    // Mentions (spec §11.1). Fire-and-forget for the same reason indexing is: a post must never fail
    // to save because the roster lookup or an alert leg was unavailable.
    void forumMentionService
      .record({ post, thread: input.thread, author: input.author })
      .catch((err) => log.warn({ err: String(err) }, 'mention recording failed'));

    void forumIndexService.indexPost({
      postId: String(post._id),
      threadId: String(input.thread._id),
      categoryId: String(input.thread.category_id),
      title: input.thread.title,
      author: input.author.display_name,
      // Filenames ride along in the embedded text: an agent searching "the crash log Scout posted"
      // should find the post that carries it, not just the one that spells the name out in prose.
      body: files.length ? `${input.body}\n\nAttachments: ${attachmentNames(files)}` : input.body,
      createdAt: post.created_at,
    });

    return post;
  },

  /**
   * Edit a body in place, re-indexing so semantic search doesn't keep serving the old text.
   *
   * The body being replaced is pushed onto the post's `edits` history first. That costs a few hundred
   * bytes and buys the thing that makes a moderator editing somebody else's words acceptable at all:
   * the previous version is still there to read and to `revert_post` back to.
   */
  async editPost(
    post: ForumPostDoc,
    body: string,
    editor: string,
    attachments?: string[],
    reason = '',
  ): Promise<ForumPostDoc | null> {
    // `undefined` leaves the existing files alone; an explicit array (even empty) replaces them.
    const files = attachments === undefined ? null : await resolveAttachments(attachments);
    const updated = await forumPostRepository.recordEdit(
      String(post._id),
      {
        body,
        edited_at: new Date(),
        edited_by: editor,
        ...(files
          ? { attachments: files.map((f) => f._id), attachment_names: attachmentNames(files) }
          : {}),
      },
      { body: post.body, editor: post.edited_by || post.author.display_name, reason },
    );
    const thread = await forumThreadRepository.findById(String(post.thread_id));
    if (updated && thread) {
      void forumIndexService.indexPost({
        postId: String(updated._id),
        threadId: String(thread._id),
        categoryId: String(thread.category_id),
        title: thread.title,
        author: updated.author.display_name,
        body: updated.attachment_names ? `${body}\n\nAttachments: ${updated.attachment_names}` : body,
        createdAt: updated.created_at,
      });
    }
    return updated;
  },

  /**
   * Set a thread's work state and/or its owner, refusing anyone with no claim on it.
   *
   * Ownership rather than moderation. `forum_admin` is reserved for the built-in moderator and
   * checks that on every call, so routing a project manager's "this is now in progress" through it
   * would mean granting board-wide moderation to run a project — the wrong trade entirely. The
   * thread's **author** opened the work item and the **assignee** is doing it; those two are exactly
   * the people who know its state, and neither needs any power over anybody else's threads.
   *
   * The operator is not checked here: the HTTP route is already behind `requireAuth`, and an
   * operator who can delete the thread outright is not meaningfully restrained from re-labelling it.
   */
  async setWorkState(
    threadId: string,
    actor: ForumAuthor,
    patch: { state?: ForumWorkState | null; assignee?: ForumAuthor | null },
  ): Promise<ForumThreadDoc> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    if (thread.status === 'archived') throw new ForumRuleError('thread is archived', 409);

    if (actor.kind === 'agent') {
      const isAuthor = thread.author.agent_id === actor.agent_id;
      const isAssignee = thread.assignee?.agent_id === actor.agent_id;
      if (!isAuthor && !isAssignee) {
        throw new ForumRuleError(
          'only the agent that opened this thread, or the agent it is assigned to, may change its ' +
            'work state — reply on the thread and ask its owner instead',
          403,
        );
      }
    }

    const update: Record<string, unknown> = {};
    if (patch.state !== undefined) update.work_state = patch.state;
    // `null` clears the owner, which is a real intention ("nobody is on this any more"), so the key
    // being present matters more than its value being truthy.
    if (patch.assignee !== undefined) update.assignee = patch.assignee;

    const updated = await forumThreadRepository.update(threadId, update);
    if (!updated) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    return updated;
  },

  /** Sticky a thread to the top of its category. Author-only, by the same argument as `setWorkState`. */
  async setPinned(threadId: string, actor: ForumAuthor, pinned: boolean): Promise<ForumThreadDoc> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    if (actor.kind === 'agent' && thread.author.agent_id !== actor.agent_id) {
      throw new ForumRuleError(
        'only the agent that opened this thread may pin it — pinning is how a category says what ' +
          'to read first, so it is not something one agent does to another\'s thread',
        403,
      );
    }
    const updated = await forumThreadRepository.update(threadId, { pinned });
    if (!updated) throw new ForumRuleError(`no such thread: "${threadId}"`, 404);
    return updated;
  },

  async deletePost(postId: string): Promise<boolean> {
    const ok = await forumPostRepository.softDelete(postId);
    if (ok) {
      void forumIndexService.removePosts([postId]);
      // A queue entry pointing at a post nobody can read any more is pure noise, so mentions go with
      // the post — unlike the post itself, which is soft-deleted because things still cite it.
      void forumMentionRepository.removeByPost(postId);
    }
    return ok;
  },

  async deleteThread(threadId: string): Promise<boolean> {
    const postIds = await forumPostRepository.removeByThread(threadId);
    const ok = await forumThreadRepository.remove(threadId);
    if (postIds.length) void forumIndexService.removePosts(postIds);
    void forumMentionRepository.removeByThread(threadId);
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

  /**
   * Re-embed every post in a thread. Needed after a retitle: the indexed text is `title + body`, so a
   * thread renamed to be findable would otherwise keep matching on the vague title it was renamed
   * away from. Sequential rather than parallel — this runs in a moderation turn, not a hot path, and
   * a burst of concurrent embeds would just queue on the CPU embeddings server anyway.
   */
  async reindexThread(threadId: string): Promise<void> {
    const thread = await forumThreadRepository.findById(threadId);
    if (!thread) return;
    const posts = await forumPostRepository.listByThread(threadId, 200);
    for (const post of posts) {
      await forumIndexService.indexPost({
        postId: String(post._id),
        threadId,
        categoryId: String(thread.category_id),
        title: thread.title,
        author: post.author.display_name,
        body: post.body,
        createdAt: post.created_at,
      });
    }
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
