import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { forumCategoryRepository } from '../../../domain/forum/forum-category.repository';
import { forumThreadRepository } from '../../../domain/forum/forum-thread.repository';
import { forumPostRepository } from '../../../domain/forum/forum-post.repository';
import { forumService, ForumRuleError, type ForumSearchMode } from '../../../domain/forum/forum.service';
import { OPERATOR_AUTHOR } from '../../../domain/forum/forum-author';
import { FORUM_THREAD_STATUSES } from '../../../domain/forum/forum-thread.model';
import type { ForumCategoryDoc } from '../../../domain/forum/forum-category.model';
import type { ForumThreadDoc } from '../../../domain/forum/forum-thread.model';
import type { ForumPostDoc } from '../../../domain/forum/forum-post.model';

const log = createLogger('forum-route');

/**
 * The operator's view of the agent forum (`FORUM_PLAN.md` §3). Mounted behind `requireAuth`.
 *
 * Everything written through here is authored by `Operator` — the human is an admin *member* of the
 * board, not an outside administrator, so their posts sit in the same threads as the agents' and are
 * indexed and searchable identically. Moderation (pin, lock, archive, delete, resolve) is
 * operator-only by construction: no agent-facing tool action reaches these handlers.
 */
export const forumRouter = Router();

function shapeCategory(doc: ForumCategoryDoc) {
  return {
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    description: doc.description,
    position: doc.position,
    enabled: doc.enabled,
    agentsCanPost: doc.agents_can_post,
    createdAt: doc.created_at,
  };
}

function shapeThread(doc: ForumThreadDoc) {
  return {
    id: String(doc._id),
    categoryId: String(doc.category_id),
    title: doc.title,
    author: doc.author,
    status: doc.status,
    pinned: doc.pinned,
    tags: doc.tags,
    postCount: doc.post_count,
    viewCount: doc.view_count,
    lastPostAt: doc.last_post_at,
    lastPostAuthor: doc.last_post_author,
    resolvedPostId: doc.resolved_post_id ? String(doc.resolved_post_id) : null,
    createdAt: doc.created_at,
  };
}

function shapePost(doc: ForumPostDoc) {
  return {
    id: String(doc._id),
    threadId: String(doc.thread_id),
    author: doc.author,
    body: doc.body,
    replyTo: doc.reply_to ? String(doc.reply_to) : null,
    editedAt: doc.edited_at,
    editedBy: doc.edited_by,
    createdAt: doc.created_at,
  };
}

/** Turn a `ForumRuleError` into its intended status; anything else keeps bubbling to the 500 handler. */
function ruleStatus(err: unknown): number | null {
  return err instanceof ForumRuleError ? err.status : null;
}

// --- categories ------------------------------------------------------------

forumRouter.get('/categories', async (_req, res) => {
  const overview = await forumService.categoryOverview();
  res.json(
    overview.map(({ category, threadCount, postCount, lastThread }) => ({
      ...shapeCategory(category),
      threadCount,
      postCount,
      lastThread: lastThread
        ? {
            id: String(lastThread._id),
            title: lastThread.title,
            lastPostAt: lastThread.last_post_at,
            lastPostAuthor: lastThread.last_post_author,
          }
        : null,
    })),
  );
});

forumRouter.post('/categories', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const created = await forumCategoryRepository.create({
    name,
    description: String(req.body?.description ?? '').trim(),
    position: Number(req.body?.position) || 100,
    agents_can_post: req.body?.agentsCanPost !== false,
  });
  res.status(201).json(shapeCategory(created));
});

forumRouter.patch('/categories/:id', async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim();
  if (typeof req.body?.description === 'string') patch.description = req.body.description;
  if (typeof req.body?.position === 'number') patch.position = req.body.position;
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  if (typeof req.body?.agentsCanPost === 'boolean') patch.agents_can_post = req.body.agentsCanPost;

  const updated = await forumCategoryRepository.update(req.params.id, patch);
  if (!updated) {
    res.status(404).json({ error: 'category not found' });
    return;
  }
  res.json(shapeCategory(updated));
});

forumRouter.delete('/categories/:id', async (req, res) => {
  const category = await forumCategoryRepository.findById(req.params.id);
  if (!category) {
    res.status(404).json({ error: 'category not found' });
    return;
  }
  const threads = await forumThreadRepository.countByCategory(category._id);
  // Deleting a populated category would orphan its threads out of every listing, so it takes intent.
  if (threads > 0 && req.query.force !== '1') {
    res.status(409).json({ error: `category holds ${threads} thread(s)`, detail: 'retry with ?force=1' });
    return;
  }
  for (const thread of await forumThreadRepository.list({ categoryId: String(category._id), includeArchived: true, limit: 200 })) {
    await forumService.deleteThread(String(thread._id));
  }
  await forumCategoryRepository.remove(req.params.id);
  res.status(204).end();
});

// --- threads ---------------------------------------------------------------

forumRouter.get('/threads', async (req, res) => {
  const categoryId = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
  const threads = await forumThreadRepository.list({
    categoryId,
    includeArchived: req.query.includeArchived === '1',
    limit: Number(req.query.limit) || 50,
  });
  res.json(threads.map(shapeThread));
});

forumRouter.post('/threads', async (req, res) => {
  const category = String(req.body?.category ?? '').trim();
  const title = String(req.body?.title ?? '').trim();
  const body = String(req.body?.body ?? '').trim();
  if (!category || !title || !body) {
    res.status(400).json({ error: 'category, title and body are required' });
    return;
  }
  try {
    const { thread, post } = await forumService.createThread({
      category,
      title,
      body,
      author: OPERATOR_AUTHOR,
      tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [],
      byAgent: false,
    });
    res.status(201).json({ ...shapeThread(thread), posts: [shapePost(post)] });
  } catch (err) {
    const status = ruleStatus(err);
    if (status === null) throw err;
    res.status(status).json({ error: (err as Error).message });
  }
});

forumRouter.get('/threads/:id', async (req, res) => {
  const thread = await forumThreadRepository.findById(req.params.id);
  if (!thread) {
    res.status(404).json({ error: 'thread not found' });
    return;
  }
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;
  const [posts, total] = await Promise.all([
    forumPostRepository.listByThread(req.params.id, limit, offset),
    forumPostRepository.countByThread(req.params.id),
  ]);
  // Author post-counts power the "1,204 posts" line under each avatar — one aggregation, not one per row.
  const postCounts = await forumPostRepository.countsByAuthor([
    ...new Set(posts.map((p) => p.author.display_name)),
  ]);
  void forumThreadRepository.incrementViews(req.params.id);

  res.json({
    ...shapeThread(thread),
    posts: posts.map(shapePost),
    total,
    offset,
    authorPostCounts: postCounts,
  });
});

forumRouter.patch('/threads/:id', async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.title === 'string' && req.body.title.trim()) patch.title = req.body.title.trim();
  if (typeof req.body?.pinned === 'boolean') patch.pinned = req.body.pinned;
  if (typeof req.body?.categoryId === 'string' && req.body.categoryId) patch.category_id = req.body.categoryId;
  if (typeof req.body?.status === 'string') {
    if (!(FORUM_THREAD_STATUSES as readonly string[]).includes(req.body.status)) {
      res.status(400).json({ error: `status must be one of: ${FORUM_THREAD_STATUSES.join(', ')}` });
      return;
    }
    patch.status = req.body.status;
  }
  // `null` clears the verdict, a string sets it — so the key has to be present-but-undefined-safe.
  if ('resolvedPostId' in (req.body ?? {})) patch.resolved_post_id = req.body.resolvedPostId || null;

  const updated = await forumThreadRepository.update(req.params.id, patch);
  if (!updated) {
    res.status(404).json({ error: 'thread not found' });
    return;
  }
  res.json(shapeThread(updated));
});

forumRouter.delete('/threads/:id', async (req, res) => {
  const ok = await forumService.deleteThread(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'thread not found' });
    return;
  }
  log.info({ threadId: req.params.id }, 'forum thread deleted by operator');
  res.status(204).end();
});

// --- posts -----------------------------------------------------------------

forumRouter.post('/threads/:id/posts', async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  try {
    const thread = await forumService.requireOpenThread(req.params.id);
    const post = await forumService.addPost({
      thread,
      body,
      author: OPERATOR_AUTHOR,
      replyTo: typeof req.body?.replyTo === 'string' ? req.body.replyTo : null,
    });
    res.status(201).json(shapePost(post));
  } catch (err) {
    const status = ruleStatus(err);
    if (status === null) throw err;
    res.status(status).json({ error: (err as Error).message });
  }
});

forumRouter.patch('/posts/:id', async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  const post = await forumPostRepository.findById(req.params.id);
  if (!post) {
    res.status(404).json({ error: 'post not found' });
    return;
  }
  const updated = await forumService.editPost(post, body, OPERATOR_AUTHOR.display_name);
  res.json(shapePost(updated ?? post));
});

forumRouter.delete('/posts/:id', async (req, res) => {
  const ok = await forumService.deletePost(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'post not found' });
    return;
  }
  res.status(204).end();
});

// --- search ----------------------------------------------------------------

forumRouter.get('/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) {
    res.status(400).json({ error: 'q is required' });
    return;
  }
  const mode = ['keyword', 'semantic', 'both'].includes(String(req.query.mode))
    ? (String(req.query.mode) as ForumSearchMode)
    : 'both';
  const hits = await forumService.search(query, {
    mode,
    categoryId: typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined,
    limit: Number(req.query.limit) || 15,
  });
  res.json(hits);
});
