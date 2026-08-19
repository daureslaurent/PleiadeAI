import { Router } from 'express';
import multer from 'multer';
import { createLogger } from '../../../config/logger';
import { forumCategoryRepository } from '../../../domain/forum/forum-category.repository';
import { forumThreadRepository } from '../../../domain/forum/forum-thread.repository';
import { forumPostRepository } from '../../../domain/forum/forum-post.repository';
import { forumFileRepository } from '../../../domain/forum/forum-file.repository';
import { forumService, ForumRuleError, type ForumSearchMode } from '../../../domain/forum/forum.service';
import { OPERATOR_AUTHOR } from '../../../domain/forum/forum-author';
import { forumMentionRepository } from '../../../domain/forum/forum-mention.repository';
import { forumMentionService } from '../../../domain/forum/forum-mention.service';
import { forumMentionRunner, MentionRunError } from '../../../domain/forum/forum-mention-runner';
import type { ForumMentionDoc, ForumMentionStatus } from '../../../domain/forum/forum-mention.model';
import { FORUM_THREAD_STATUSES } from '../../../domain/forum/forum-thread.model';
import type { ForumCategoryDoc } from '../../../domain/forum/forum-category.model';
import type { ForumThreadDoc } from '../../../domain/forum/forum-thread.model';
import type { ForumPostDoc } from '../../../domain/forum/forum-post.model';
import type { ForumFileDoc } from '../../../domain/forum/forum-file.model';

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

/**
 * Operator uploads to the file registry. Held in memory, then straight into GridFS. The ceiling is
 * generous on purpose (spec §10): the board is a trusted single-operator fleet, and a rendered clip
 * or a log bundle is the realistic payload.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } });

function shapeFile(doc: ForumFileDoc, refs?: number) {
  return {
    id: String(doc._id),
    filename: doc.filename,
    mime: doc.mime,
    size: doc.size,
    kind: doc.kind,
    sha256: doc.sha256,
    uploadedBy: doc.uploaded_by,
    createdAt: doc.created_at,
    ...(refs === undefined ? {} : { refCount: refs }),
  };
}

/** Attachment ids off a request body, tolerant of a single string (a form-encoded client). */
function attachmentIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  return (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean);
}

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

function shapePost(doc: ForumPostDoc, files: ForumFileDoc[] = []) {
  return {
    id: String(doc._id),
    threadId: String(doc.thread_id),
    author: doc.author,
    body: doc.body,
    attachments: files.map((f) => shapeFile(f)),
    replyTo: doc.reply_to ? String(doc.reply_to) : null,
    editedAt: doc.edited_at,
    editedBy: doc.edited_by,
    createdAt: doc.created_at,
  };
}

function shapeMention(doc: ForumMentionDoc) {
  return {
    id: String(doc._id),
    postId: String(doc.post_id),
    threadId: String(doc.thread_id),
    categoryId: String(doc.category_id),
    threadTitle: doc.thread_title,
    excerpt: doc.excerpt,
    target: doc.target,
    author: doc.author,
    status: doc.status,
    notified: doc.notified,
    sessionId: doc.session_id ? String(doc.session_id) : null,
    replyPostId: doc.reply_post_id ? String(doc.reply_post_id) : null,
    answeredAt: doc.answered_at,
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
      attachments: attachmentIds(req.body?.attachments),
      byAgent: false,
    });
    res.status(201).json({
      ...shapeThread(thread),
      posts: [shapePost(post, await forumFileRepository.findByIds(post.attachments ?? []))],
    });
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

  // Resolve every attached file for the page in one query rather than one per post.
  const files = await forumFileRepository.findByIds(posts.flatMap((p) => p.attachments ?? []));
  const fileById = new Map(files.map((f) => [String(f._id), f]));

  res.json({
    ...shapeThread(thread),
    posts: posts.map((p) =>
      shapePost(
        p,
        (p.attachments ?? [])
          .map((id) => fileById.get(String(id)))
          .filter((f): f is ForumFileDoc => Boolean(f)),
      ),
    ),
    total,
    offset,
    authorPostCounts: postCounts,
    // The mentions raised by the posts on this page, so every `@name` chip knows its own state and
    // can offer Run without the thread firing one request per chip.
    mentions: (await forumMentionRepository.listByPosts(posts.map((p) => p._id))).map(shapeMention),
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
      attachments: attachmentIds(req.body?.attachments),
    });
    res.status(201).json(shapePost(post, await forumFileRepository.findByIds(post.attachments ?? [])));
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
  try {
    const updated = await forumService.editPost(
      post,
      body,
      OPERATOR_AUTHOR.display_name,
      attachmentIds(req.body?.attachments),
    );
    const shown = updated ?? post;
    res.json(shapePost(shown, await forumFileRepository.findByIds(shown.attachments ?? [])));
  } catch (err) {
    const status = ruleStatus(err);
    if (status === null) throw err;
    res.status(status).json({ error: (err as Error).message });
  }
});

forumRouter.delete('/posts/:id', async (req, res) => {
  const ok = await forumService.deletePost(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'post not found' });
    return;
  }
  res.status(204).end();
});

// --- files (the registry, spec §10) ----------------------------------------

// --- mentions (FORUM_PLAN.md §11) ------------------------------------------

/**
 * Who can be addressed, for the composer's `@` autocomplete. Muted agents stay in the list, marked:
 * you can still address an agent whose alerts you turned off, and the UI should say so rather than
 * quietly dropping it from the roster.
 */
forumRouter.get('/mentions/roster', async (_req, res) => {
  res.json(await forumMentionService.roster());
});

/** Pending count for the sidebar badge (`agentId` narrows it to one agent's queue). */
forumRouter.get('/mentions/count', async (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  res.json({
    count: await forumMentionRepository.countPending(agentId),
    byAgent: agentId ? undefined : await forumMentionRepository.pendingByAgent(),
  });
});

/** The triage list, and the per-agent and per-thread views of the same rows. */
forumRouter.get('/mentions', async (req, res) => {
  const raw = req.query.status;
  const status =
    raw === 'all' || raw === 'answered' || raw === 'dismissed' || raw === 'pending'
      ? (raw as ForumMentionStatus | 'all')
      : 'pending';
  const rows = await forumMentionRepository.list({
    status,
    agentId: typeof req.query.agentId === 'string' ? req.query.agentId : undefined,
    operator: req.query.operator === '1',
    threadId: typeof req.query.threadId === 'string' ? req.query.threadId : undefined,
    limit: Number(req.query.limit) || undefined,
  });
  res.json(rows.map(shapeMention));
});

/**
 * Answer a mention: spawn a `forum`-origin session, run one turn, post the answer back to the thread
 * (spec §11.3). Returns as soon as the session exists — the operator watches the turn stream in the
 * Chat page rather than waiting on this request.
 */
forumRouter.post('/mentions/:id/run', async (req, res) => {
  try {
    res.status(202).json(await forumMentionRunner.start(req.params.id));
  } catch (err) {
    if (err instanceof MentionRunError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** Triage: this one didn't need a turn. Reversible — `pending` puts it back in the queue. */
forumRouter.post('/mentions/:id/status', async (req, res) => {
  const status = req.body?.status === 'pending' ? 'pending' : 'dismissed';
  const ok = await forumMentionService.setStatus(req.params.id, status);
  if (!ok) {
    res.status(404).json({ error: 'mention not found' });
    return;
  }
  res.json({ ok: true, status });
});

/** The whole registry, newest first, with how many live posts reference each file. */
forumRouter.get('/files', async (req, res) => {
  const files = await forumFileRepository.list({
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    kind: typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined,
    limit: Number(req.query.limit) || 200,
  });
  const refs = await forumFileRepository.usageCounts(files.map((f) => f._id));
  res.json(files.map((f) => shapeFile(f, refs[String(f._id)] ?? 0)));
});

/** Where a file is used — the "what references this" panel, and what makes a delete safe to judge. */
forumRouter.get('/files/:id/usage', async (req, res) => {
  const file = await forumFileRepository.findById(req.params.id);
  if (!file) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  res.json(await forumFileRepository.usage(req.params.id));
});

/** Operator upload. Deduped by content hash, so re-uploading the same bytes is free and idempotent. */
forumRouter.post('/files', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'a file is required (multipart field "file")' });
    return;
  }
  const { file: stored, deduped } = await forumFileRepository.store({
    bytes: file.buffer,
    filename: file.originalname || 'file',
    mime: file.mimetype || 'application/octet-stream',
    uploadedBy: OPERATOR_AUTHOR,
  });
  log.info({ fileId: String(stored._id), filename: stored.filename, deduped }, 'forum file uploaded by operator');
  res.status(201).json({ ...shapeFile(stored), deduped });
});

/**
 * Stream a file's bytes. Range support is what makes an attached video usable — a player HEADs, then
 * issues partial reads to seek; serving the whole clip for each of those makes scrubbing re-download
 * it every time. Disposition follows the media type so a video plays rather than downloading, unless
 * `?download=1` asks otherwise.
 */
const INLINE_MIME = /^(image|video|audio)\/|^(application\/pdf|text\/plain)$/;

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  // `bytes=-500` means the *last* 500 bytes — how a player reads a trailing mp4 index.
  if (!rawStart) {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

forumRouter.get('/files/:id/content', async (req, res) => {
  const doc = await forumFileRepository.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  const mime = doc.mime || 'application/octet-stream';
  const size = doc.size ?? 0;
  const name = doc.filename.replace(/"/g, '');
  const inline = req.query.download !== '1' && INLINE_MIME.test(mime);

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${name}"`);

  if (req.method === 'HEAD') {
    if (size) res.setHeader('Content-Length', String(size));
    res.status(200).end();
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (req.headers.range && !range && size > 0) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    forumFileRepository.openDownloadRange(doc, range.start, range.end).pipe(res);
    return;
  }
  if (size) res.setHeader('Content-Length', String(size));
  forumFileRepository.openDownload(doc).pipe(res);
});

/** Soft-delete a file and detach it from every post — a chip that 404s is worse than a missing chip. */
forumRouter.delete('/files/:id', async (req, res) => {
  const ok = await forumFileRepository.remove(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'file not found' });
    return;
  }
  log.info({ fileId: req.params.id }, 'forum file deleted by operator');
  res.status(204).end();
});

/** Detach one file from one post, leaving it in the registry (the reversible half of the delete). */
forumRouter.delete('/posts/:postId/attachments/:fileId', async (req, res) => {
  const ok = await forumFileRepository.detach(req.params.postId, req.params.fileId);
  if (!ok) {
    res.status(404).json({ error: 'post or attachment not found' });
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
