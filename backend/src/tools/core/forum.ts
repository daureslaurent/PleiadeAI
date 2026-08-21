import { basename, extname } from 'path';
import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { forumCategoryRepository } from '../../domain/forum/forum-category.repository';
import {
  autoRunBudget,
  autoRunWindowMs,
  forumThreadRepository,
} from '../../domain/forum/forum-thread.repository';
import { FORUM_WORK_STATES, type ForumWorkState } from '../../domain/forum/forum-thread.model';
import { loadRoster } from '../../domain/forum/forum-roster';
import {
  blockReason,
  planSummons,
  summonContextFor,
  type SummonPlan,
} from '../../domain/forum/forum-mention.service';
import { settingsService } from '../../domain/settings/settings.service';
import { forumPostRepository } from '../../domain/forum/forum-post.repository';
import { forumFileRepository } from '../../domain/forum/forum-file.repository';
import { resourceRepository } from '../../domain/resources/resource.repository';
import { forumService, ForumRuleError, type ForumSearchMode } from '../../domain/forum/forum.service';
import type { ForumAuthor } from '../../domain/forum/forum-author';
import { FileOpError, IsolationBlockedError, readFileBytes } from './fs/env-fs';
import { readResourceBytes } from './resource-bytes';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { ForumFileDoc } from '../../domain/forum/forum-file.model';
import type { Tool, ToolConfigField, ToolContext, ToolResult } from '../types';

const log = createLogger('tool:forum');

/**
 * Warn an agent reading a thread that is about to stop answering itself.
 *
 * Reported only in the last few units, and never when windowing is off and the ceiling is the whole
 * story anyway. The point is actionable: a thread with one automatic reply left is one where the
 * next `@mention` will be the last that wakes anybody, and the fix — continue in a fresh thread —
 * is only available to somebody who knows it before they post.
 */
async function budgetWarning(
  thread: Parameters<typeof autoRunBudget>[0],
): Promise<{ auto_reply_budget?: { remaining: number; resets_at?: string; note: string } }> {
  const settings = await settingsService.get();
  if (!settings.forum_auto_reply) return {};
  const windowMs = autoRunWindowMs(settings.forum_auto_reply_window_hours);
  const budget = autoRunBudget(thread, settings.forum_auto_reply_max_per_thread, windowMs);
  if (budget.remaining > 3) return {};
  return {
    auto_reply_budget: {
      remaining: budget.remaining,
      resets_at: budget.resetsAt?.toISOString(),
      note: budget.exhausted
        ? 'This thread has spent its automatic replies — `wake` here will not run anyone until the ' +
          'operator does it by hand. Open a fresh thread for anything that still needs doing.'
        : 'This thread is nearly out of automatic replies. Once they run out, `wake` here runs ' +
          'nobody, so start a new thread for the next piece of work rather than continuing here.',
    },
  };
}

/**
 * Operator-tunable behaviour (Tools page). The thresholds are the two dials that decide whether the
 * board stays useful at scale: too low a `semantic_threshold` and every search returns noise, too low
 * a `duplicate_threshold` and agents can never open a genuinely new thread.
 */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'allow_category_creation',
    label: 'Agents may create categories',
    type: 'boolean',
    default: false,
    hint: 'Off by default: an agent that invents a category per topic turns the board into a junk drawer.',
  },
  {
    key: 'default_category',
    label: 'Default category',
    type: 'select',
    optionsSource: 'forum_categories',
    default: '',
    hint: 'Used when an agent posts without naming a category.',
  },
  {
    key: 'search_limit',
    label: 'Search results',
    type: 'number',
    default: 8,
    hint: 'How many threads a search returns. Higher costs the agent context on every search.',
  },
  {
    key: 'semantic_threshold',
    label: 'Semantic score floor',
    type: 'number',
    default: 0.45,
    hint: 'Minimum cosine similarity for a semantic hit. Below ~0.4 unrelated posts start matching.',
  },
  {
    key: 'max_file_mb',
    label: 'Max attachment size (MB)',
    type: 'number',
    default: 100,
    hint: 'Per file. Permissive by default — the failure worth avoiding is an agent unable to share evidence.',
  },
  {
    key: 'max_attachments_per_post',
    label: 'Attachments per post',
    type: 'number',
    default: 10,
    hint: 'Ceiling on how many files one post may carry.',
  },
  {
    key: 'repeat_threshold',
    label: 'Repeat-post cutoff',
    type: 'number',
    default: 0.8,
    hint: 'Refuse a reply when this fraction of it is already covered by the author\'s own last few posts on the same thread. 0 disables it. Measured against the real runaway exchange: restatements score 0.83–0.94, posts that actually moved the work forward 0.47–0.78.',
  },
  {
    key: 'duplicate_threshold',
    label: 'Duplicate-thread cutoff',
    type: 'number',
    default: 0.88,
    hint: 'A new thread this similar to an existing one is refused until the agent passes force=true.',
  },
];

/** Hard ceiling on `read_thread`, independent of what the agent asks for. See the tool JSDoc. */
const MAX_POSTS_PER_READ = 30;

/** A 24-hex string is a registry file id; anything else is a handle or a path. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** A resource handle from this session's pool (`img_3`, `blob_1`). */
const HANDLE = /^(?:img|blob)_\d+$/;

/**
 * Above this, `get_attachment` mints a *blob* handle for an image rather than an inline one. A 30 MB
 * frame folded into a multimodal context is a turn nobody can afford; as a blob it is still writable
 * to disk and forwardable, just not automatically looked at.
 */
const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  pdf: 'application/pdf', json: 'application/json', csv: 'text/csv', md: 'text/markdown',
  txt: 'text/plain', log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', html: 'text/html',
  ts: 'text/plain', js: 'text/plain', py: 'text/plain', sh: 'text/plain', patch: 'text/x-diff',
  diff: 'text/x-diff',
};

/** Best-effort MIME from a filename. Only affects how the UI previews it, never whether it stores. */
function mimeFromName(name: string): string {
  const ext = extname(name).replace('.', '').toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** The metadata shape an agent sees for a file — never bytes. `get_attachment` fetches those. */
function shapeFile(f: ForumFileDoc) {
  return {
    file_id: String(f._id),
    filename: f.filename,
    mime: f.mime,
    size: f.size,
    kind: f.kind,
    uploaded_by: f.uploaded_by.display_name,
  };
}

/**
 * Put one artifact into the registry, from whichever of the three sources the agent used.
 *
 * All three exist because each covers a class the others can't reach: a `handle` is anything already
 * in the session's resource pool (a generated image, a fetched PDF), a `path` goes through
 * `readFileBytes` and therefore through the agent's `AgentExecutor` — so a build artifact inside an
 * isolation container or on the far side of an SSH profile uploads without ever touching the
 * backend's disk — and `content` covers a file the agent just composed in its head.
 */
async function uploadOne(
  ctx: ToolContext,
  source: { handle?: string; path?: string; content?: string; filename?: string; mime?: string },
  author: ForumAuthor,
  maxBytes: number,
): Promise<ForumFileDoc> {
  let bytes: Buffer;
  let filename = (source.filename ?? '').trim();
  let mime = (source.mime ?? '').trim();

  if (source.handle) {
    const found = await readResourceBytes(ctx, source.handle);
    if (!found) throw new ForumRuleError(`no resource with handle "${source.handle}" in this session`, 404);
    bytes = found;
    // The handle may name a *pooled* resource (an image the operator dropped into the chat) rather
    // than a stored one; those never reach the resource store, so their type has to come off the
    // pool's data URL. Without this an attached screenshot lands on the board as an unnamed
    // octet-stream and renders as a download chip instead of a picture.
    const stored = await resourceRepository.findByHandle(ctx.sessionId, source.handle);
    const pooled = ctx.attachedImages?.find((i) => i.id === source.handle);
    const pooledMime = pooled?.mime || /^data:([^;,]+)/.exec(pooled?.dataUrl ?? '')?.[1] || '';
    mime = mime || stored?.mime || pooledMime || 'application/octet-stream';
    const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0];
    filename = filename || stored?.filename || pooled?.filename || `${source.handle}${ext ? `.${ext}` : ''}`;
  } else if (source.path) {
    bytes = await readFileBytes(ctx, source.path);
    filename = filename || basename(source.path) || 'file';
    mime = mime || mimeFromName(filename);
  } else if (source.content != null) {
    bytes = Buffer.from(source.content, 'utf8');
    filename = filename || 'note.txt';
    mime = mime || mimeFromName(filename);
  } else {
    throw new ForumRuleError('upload_file needs one of: handle, path, content');
  }

  if (bytes.length > maxBytes) {
    throw new ForumRuleError(
      `"${filename}" is ${(bytes.length / 1e6).toFixed(1)} MB — over the ${(maxBytes / 1e6).toFixed(0)} MB limit`,
      413,
    );
  }
  const { file } = await forumFileRepository.store({ bytes, filename, mime, uploadedBy: author });
  return file;
}

/**
 * Turn the `attachments` argument of a post/reply into registry ids.
 *
 * Accepting registry ids *and* handles *and* paths in one array is what keeps the common case a
 * single call: an agent that just rendered a chart says `attachments: ["img_1"]` rather than
 * uploading first and threading an id through. Anything already in the registry is passed straight
 * through, so `upload_file` → `reply` still works and costs nothing extra.
 */
async function resolveAttachmentArg(
  ctx: ToolContext,
  raw: unknown,
  author: ForumAuthor,
  limits: { maxBytes: number; maxCount: number },
): Promise<ForumFileDoc[]> {
  const specs = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map((v) => String(v).trim()).filter(Boolean);
  if (!specs.length) return [];
  if (specs.length > limits.maxCount) {
    throw new ForumRuleError(`too many attachments (${specs.length}); the limit is ${limits.maxCount}`);
  }

  const files: ForumFileDoc[] = [];
  for (const spec of specs) {
    if (OBJECT_ID.test(spec)) {
      const existing = await forumFileRepository.findById(spec);
      if (!existing) throw new ForumRuleError(`no such file in the registry: "${spec}"`, 404);
      files.push(existing);
    } else if (HANDLE.test(spec)) {
      files.push(await uploadOne(ctx, { handle: spec }, author, limits.maxBytes));
    } else {
      files.push(await uploadOne(ctx, { path: spec }, author, limits.maxBytes));
    }
  }
  return files;
}

/**
 * `forum` — the agents' shared board (spec `FORUM_PLAN.md` §5).
 *
 * ## Why a forum, and why it is shaped like this
 *
 * Agent memory is private, implicit and per-agent; `ask_agent` is synchronous and evaporates when the
 * turn ends. Neither gives the fleet a *durable, addressable, shared* body of knowledge. A forum does,
 * and it is append-only (concurrent agents can't clobber each other), citable (a thread id is a stable
 * reference), and readable by the operator without any extra tooling.
 *
 * Three failure modes shape the tool surface:
 *
 * - **Context flooding.** Twelve busy agents produce more board than any one agent can read, so
 *   retrieval is always search-scoped: `search` returns snippets and never bodies, `read_thread` is
 *   paginated behind `MAX_POSTS_PER_READ`, and nothing here is ever auto-injected into a prompt the
 *   way recalled memories are. Reading the forum is always a deliberate act.
 * - **Duplicate threads.** `post_thread` runs a similarity check and refuses, returning the candidates
 *   it found, unless the caller passes `force`. The model gets to see what already exists and decide.
 * - **Echo chambers.** Authorship comes from `ToolContext`, never from an argument, so a claim can
 *   always be traced to the agent that actually made it.
 */
export const forum: Tool = {
  name: 'forum',
  description:
    'The shared agent forum: a persistent, cross-agent board of threads and posts used as a team ' +
    'knowledge base, for coordinating work, and for proposing and reviewing each other\'s work. ' +
    'Unlike your private memory, everything here is visible to every other agent and to the operator. ' +
    'This is where you hand off *work*: `ask_agent` is for something you need answered inside this ' +
    'turn (a web search, a lookup); anything long, open-ended or multi-step goes on the board instead ' +
    '— post what you need and write `@agent name` to address whoever owns it, then carry on. ' +
    'Post immediately, without waiting to finish, when you find something the rest of the fleet is ' +
    'wrong about or blocked by. ' +
    'ALWAYS `search` before you `post_thread` — the answer is often already on the board, and posting ' +
    'a duplicate is worse than not posting. Cite the thread id when you build on something you read. ' +
    'Post findings that will still matter next week (causes, fixes, gotchas), not turn-by-turn chatter. ' +
    'Posts can carry files — attach the chart, the log bundle, the rendered clip rather than describing ' +
    'it, and use `get_attachment` to pull a file another agent attached into your own session. ' +
    'A thread you opened is also a work item you can track: `set_state` marks it todo/in_progress/' +
    'blocked/done and `assign` names the agent who owns it, so "what is still open and who has it" ' +
    'is one `list_threads` call instead of a reading exercise. Keep them current — a board where ' +
    'finished work still says in_progress is worse than one with no states at all.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list_categories',
          'search',
          'list_threads',
          'read_thread',
          'post_thread',
          'reply',
          'edit_post',
          'set_state',
          'assign',
          'pin_thread',
          'create_category',
          'upload_file',
          'list_files',
          'get_attachment',
        ],
        description:
          "'search' finds existing threads (do this first); 'read_thread' opens one; 'post_thread' " +
          "starts a new topic; 'reply' adds to an existing one; 'edit_post' revises your own post; " +
          "'set_state' / 'assign' track a thread you opened as a work item; 'pin_thread' sticks it " +
          "to the top of its category; 'get_attachment' downloads a file someone attached so you " +
          'can actually use it.',
      },
      query: { type: 'string', description: 'For `search`: what you are looking for, in plain words.' },
      mode: {
        type: 'string',
        enum: ['keyword', 'semantic', 'both'],
        description:
          "For `search`: 'keyword' for exact strings (error codes, filenames, ids), 'semantic' for " +
          "concepts, 'both' (default) for either.",
      },
      category: {
        type: 'string',
        description: 'Category name or id — scopes `search`/`list_threads`, or targets `post_thread`.',
      },
      thread_id: { type: 'string', description: 'For `read_thread` and `reply`.' },
      post_id: { type: 'string', description: 'For `edit_post`: one of your own posts.' },
      title: { type: 'string', description: 'For `post_thread`: a specific, searchable topic line.' },
      body: {
        type: 'string',
        description:
          'For `post_thread`/`reply`/`edit_post`: markdown. State what you verified versus what you ' +
          'are guessing — other agents will act on this. Writing `@name` here *addresses* somebody: ' +
          'it tells them, and they see it on their next turn. It does not make them run — use `wake` ' +
          'for that. Do not repeat what the thread already says; add only what is new.',
      },
      wake: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For `post_thread`/`reply`: agents to *run now* over this post, by exact name. Each one ' +
          'is a full turn on the GPU, so name only those you actually need something from, and say ' +
          'in the body what you need from each. Leave it out when you are answering someone, ' +
          'acknowledging, or reporting done — your post already reaches everyone on the thread, and ' +
          'waking them back is how two agents end up talking past each other forever.',
      },
      reply_to: { type: 'string', description: 'For `reply`: the post id you are answering.' },
      state: {
        type: 'string',
        enum: [...FORUM_WORK_STATES, 'none'],
        description:
          "For `set_state`: where the work has got to. 'none' takes the thread back out of the work " +
          "queue. Also filters `list_threads`.",
      },
      assignee: {
        type: 'string',
        description:
          'For `assign` (and optionally `set_state`): the agent that owns this work item, by name — ' +
          'the same name you would `@`. Empty string clears it. Also filters `list_threads`.',
      },
      pinned: { type: 'boolean', description: 'For `pin_thread`: false to unpin. Defaults to true.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'For `post_thread`: optional labels.' },
      force: {
        type: 'boolean',
        description: 'For `post_thread`: post anyway after reviewing the similar threads it reported.',
      },
      name: { type: 'string', description: 'For `create_category`.' },
      description: { type: 'string', description: 'For `create_category`: what belongs in it.' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description:
          'For `post_thread`/`reply`/`edit_post`: files to attach. Each entry is a resource handle ' +
          '(`img_1`, `blob_2`), a file path in your environment (`/work/out/report.zip`), or a ' +
          'file_id already in the registry. Handles and paths are uploaded for you.',
      },
      handle: { type: 'string', description: 'For `upload_file`: a resource handle to upload (`img_1`).' },
      path: { type: 'string', description: 'For `upload_file`: a file path in your environment.' },
      content: { type: 'string', description: 'For `upload_file`: inline text to store as a file.' },
      filename: { type: 'string', description: 'For `upload_file`: the name it appears under on the board.' },
      mime: { type: 'string', description: 'For `upload_file`: MIME type, if the extension does not imply it.' },
      file_id: { type: 'string', description: 'For `get_attachment`: the file to download into your session.' },
      limit: { type: 'number', description: 'Page size for `search`/`list_threads`/`read_thread`/`list_files`.' },
      offset: { type: 'number', description: 'For `read_thread`: skip this many posts (paging).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  configSchema: CONFIG_SCHEMA,

  async execute(args, ctx): Promise<ToolResult> {
    const { config } = await toolConfigService.resolve(forum.name, CONFIG_SCHEMA);
    const searchLimit = Number(config.search_limit) || 8;
    const semanticThreshold = Number(config.semantic_threshold) || 0.45;
    const duplicateThreshold = Number(config.duplicate_threshold) || 0.88;
    const attachmentLimits = {
      maxBytes: Math.max(1, Number(config.max_file_mb) || 100) * 1024 * 1024,
      maxCount: Math.max(1, Number(config.max_attachments_per_post) || 10),
    };

    /** Identity is taken from the run, never from `args` — an agent cannot post as someone else. */
    const author: ForumAuthor = {
      kind: 'agent',
      agent_id: ctx.agentId,
      display_name: ctx.agentName,
    };

    const action = String(args.action ?? '').trim();
    const str = (key: string): string => String(args[key] ?? '').trim();
    const repeatThreshold = Math.max(0, Number(config.repeat_threshold ?? 0.8) || 0);

    /**
     * Decide who this post addresses and who it actually wakes, *before* writing it (spec §11.7).
     *
     * Done here rather than left to the write path so the tool result can name both groups. One
     * `wake` is one inference run, and until now that cost was invisible to the agent spending it:
     * a post naming three agents spawned three sessions and said nothing about having done so. The
     * same plan is handed to `addPost`, so what the agent is told and what the board records are
     * the same decision rather than two that happen to agree.
     */
    const summonsFor = async (body: string, threadId: string | null): Promise<SummonPlan> => {
      const context = await summonContextFor(ctx.sessionId);
      return planSummons({
        body,
        author,
        wake: Array.isArray(args.wake) ? args.wake.map(String) : [],
        context,
        threadId,
      });
    };

    /** `woke` / `addressed` / `not_woken`, for the tool result. Omitted when there is nothing to say. */
    const summonsReport = (plan: SummonPlan) => {
      const woke = plan.mentions.filter((m) => m.summon && !m.blocked).map((m) => m.target.name);
      const addressed = plan.mentions.filter((m) => !m.summon).map((m) => m.target.name);
      const withheld = plan.mentions
        .filter((m) => m.blocked)
        .map((m) => ({ agent: m.target.name, reason: blockReason(m.blocked!, m.target.name) }));
      return {
        ...(woke.length ? { woke } : {}),
        ...(addressed.length
          ? {
              addressed,
              addressed_note:
                'Told, not run — they will see this on their next turn. Add them to `wake` if you ' +
                'need an answer before then.',
            }
          : {}),
        ...(withheld.length ? { not_woken: withheld } : {}),
      };
    };

    try {
      switch (action) {
        case 'list_categories': {
          const categories = await forumCategoryRepository.listEnabled();
          return {
            result: {
              ok: true,
              categories: await Promise.all(
                categories.map(async (c) => ({
                  name: c.name,
                  description: c.description || undefined,
                  threads: await forumThreadRepository.countByCategory(c._id),
                  writable: c.agents_can_post,
                })),
              ),
            },
          };
        }

        case 'search': {
          const query = str('query');
          if (!query) return { result: { ok: false, error: 'query is required for search' } };
          const category = str('category');
          const resolved = category ? await forumCategoryRepository.findByIdOrName(category) : null;
          const hits = await forumService.search(query, {
            mode: (['keyword', 'semantic', 'both'].includes(str('mode')) ? str('mode') : 'both') as ForumSearchMode,
            categoryId: resolved ? String(resolved._id) : undefined,
            limit: Number(args.limit) || searchLimit,
            threshold: semanticThreshold,
          });
          return {
            result: {
              ok: true,
              count: hits.length,
              // Snippets only. Open the thread with `read_thread` when one looks right.
              results: hits.map((h) => ({
                thread_id: h.threadId,
                title: h.title,
                author: h.author,
                created_at: h.createdAt,
                snippet: h.snippet || undefined,
                match: h.source,
              })),
              ...(hits.length ? {} : { hint: 'Nothing on the board yet — this may be worth a new thread.' }),
            },
          };
        }

        case 'list_threads': {
          const category = str('category');
          const resolved = category ? await forumCategoryRepository.findByIdOrName(category) : null;
          if (category && !resolved) return { result: { ok: false, error: `no such category: "${category}"` } };
          const state = str('state');
          const threads = await forumThreadRepository.list({
            categoryId: resolved ? String(resolved._id) : undefined,
            workState: state ? [state as ForumWorkState | 'none'] : undefined,
            assignee: str('assignee') || undefined,
            limit: Number(args.limit) || 20,
          });
          return {
            result: {
              ok: true,
              threads: threads.map((t) => ({
                thread_id: String(t._id),
                title: t.title,
                author: t.author.display_name,
                replies: Math.max(0, (t.post_count ?? 1) - 1),
                status: t.status,
                state: t.work_state || undefined,
                assigned_to: t.assignee?.display_name || undefined,
                pinned: t.pinned || undefined,
                last_post_at: t.last_post_at.toISOString(),
                last_post_by: t.last_post_author,
              })),
            },
          };
        }

        case 'read_thread': {
          const threadId = str('thread_id');
          const thread = await forumThreadRepository.findById(threadId);
          if (!thread) return { result: { ok: false, error: `no such thread: "${threadId}"` } };

          const limit = Math.min(MAX_POSTS_PER_READ, Number(args.limit) || MAX_POSTS_PER_READ);
          const offset = Math.max(0, Number(args.offset) || 0);
          const [posts, total] = await Promise.all([
            forumPostRepository.listByThread(threadId, limit, offset),
            forumPostRepository.countByThread(threadId),
          ]);
          // Metadata only — a thread can carry a gigabyte of build output, and none of it belongs in
          // a context window until the agent decides it wants a specific file.
          const filesByPost = new Map<string, ForumFileDoc[]>(
            await Promise.all(
              posts.map(async (p) => [
                String(p._id),
                p.attachments?.length ? await forumFileRepository.findByIds(p.attachments) : [],
              ] as [string, ForumFileDoc[]]),
            ),
          );
          const remaining = Math.max(0, total - (offset + posts.length));
          return {
            result: {
              ok: true,
              thread_id: String(thread._id),
              title: thread.title,
              status: thread.status,
              state: thread.work_state || undefined,
              assigned_to: thread.assignee?.display_name || undefined,
              tags: thread.tags.length ? thread.tags : undefined,
              resolved_post_id: thread.resolved_post_id ? String(thread.resolved_post_id) : undefined,
              total_posts: total,
              // Surfaced only when it is nearly gone. An agent that knows this thread has one
              // automatic reply left can move the conversation to a fresh thread instead of
              // `@`-ing somebody who will never wake up — which is the failure this whole field
              // exists to make visible.
              ...(await budgetWarning(thread)),
              posts: posts.map((p) => ({
                post_id: String(p._id),
                author: p.author.display_name,
                created_at: p.created_at.toISOString(),
                body: p.body,
                in_reply_to: p.reply_to ? String(p.reply_to) : undefined,
                edited: p.edited_at ? true : undefined,
                attachments: filesByPost.get(String(p._id))?.length
                  ? filesByPost.get(String(p._id))!.map(shapeFile)
                  : undefined,
              })),
              // Explicit, so the model knows it is looking at a page and can ask for the next one.
              ...(remaining
                ? { truncated: true, remaining, next_offset: offset + posts.length }
                : {}),
              ...([...filesByPost.values()].some((f) => f.length)
                ? { hint: 'Use get_attachment with a file_id to pull one of these files into your session.' }
                : {}),
            },
          };
        }

        case 'post_thread': {
          const title = str('title');
          const body = str('body');
          const category = str('category') || String(config.default_category ?? '');
          if (!title || !body) return { result: { ok: false, error: 'title and body are required' } };
          if (!category) {
            return {
              result: { ok: false, error: 'category is required (use list_categories to see them)' },
            };
          }

          if (args.force !== true) {
            const similar = await forumService.findSimilarThreads(title, body, duplicateThreshold);
            if (similar.length) {
              return {
                result: {
                  ok: false,
                  reason: 'similar_threads_exist',
                  message:
                    'One or more threads already cover this. Read them and reply there instead — or ' +
                    'call post_thread again with force=true if your topic really is different.',
                  candidates: similar.map((h) => ({
                    thread_id: h.threadId,
                    title: h.title,
                    snippet: h.snippet || undefined,
                  })),
                },
              };
            }
          }

          const files = await resolveAttachmentArg(ctx, args.attachments, author, attachmentLimits);
          // A new thread is a new place, so a summons here is never a back-summon — but it still
          // counts against the chain depth, which is what keeps a relay of fresh threads bounded.
          const summons = await summonsFor(body, null);
          const { thread, post } = await forumService.createThread({
            category,
            title,
            body,
            author,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
            attachments: files.map((f) => String(f._id)),
            byAgent: true,
            summons,
          });
          log.info({ agent: ctx.agentName, threadId: String(thread._id) }, 'agent opened a forum thread');
          return {
            result: {
              ok: true,
              thread_id: String(thread._id),
              post_id: String(post._id),
              title: thread.title,
              ...(files.length ? { attachments: files.map(shapeFile) } : {}),
              ...summonsReport(summons),
            },
          };
        }

        case 'reply': {
          const threadId = str('thread_id');
          const body = str('body');
          if (!threadId || !body) return { result: { ok: false, error: 'thread_id and body are required' } };
          const thread = await forumService.requireOpenThread(threadId);
          const files = await resolveAttachmentArg(ctx, args.attachments, author, attachmentLimits);
          const summons = await summonsFor(body, threadId);
          const post = await forumService.addPost({
            thread,
            body,
            author,
            replyTo: str('reply_to') || null,
            attachments: files.map((f) => String(f._id)),
            summons,
            repeatThreshold,
          });
          return {
            result: {
              ok: true,
              post_id: String(post._id),
              thread_id: threadId,
              title: thread.title,
              ...(files.length ? { attachments: files.map(shapeFile) } : {}),
              ...summonsReport(summons),
            },
          };
        }

        case 'edit_post': {
          const postId = str('post_id');
          const body = str('body');
          if (!postId || !body) return { result: { ok: false, error: 'post_id and body are required' } };
          const post = await forumPostRepository.findById(postId);
          if (!post) return { result: { ok: false, error: `no such post: "${postId}"` } };
          // Rewriting another agent's post would destroy the provenance the whole board rests on.
          if (post.author.kind !== 'agent' || post.author.agent_id !== ctx.agentId) {
            return { result: { ok: false, error: 'you can only edit your own posts' } };
          }
          // Omitting `attachments` leaves the post's files alone; passing `[]` clears them.
          const files =
            args.attachments === undefined
              ? undefined
              : await resolveAttachmentArg(ctx, args.attachments, author, attachmentLimits);
          await forumService.editPost(post, body, ctx.agentName, files?.map((f) => String(f._id)));
          return {
            result: { ok: true, post_id: postId, ...(files ? { attachments: files.map(shapeFile) } : {}) },
          };
        }

        case 'set_state':
        case 'assign': {
          const threadId = str('thread_id');
          if (!threadId) return { result: { ok: false, error: 'thread_id is required' } };

          const patch: { state?: ForumWorkState | null; assignee?: ForumAuthor | null } = {};

          if (action === 'set_state' || args.state !== undefined) {
            const state = str('state');
            if (!state) return { result: { ok: false, error: 'state is required for set_state' } };
            if (state !== 'none' && !(FORUM_WORK_STATES as readonly string[]).includes(state)) {
              return {
                result: {
                  ok: false,
                  error: `state must be one of: ${FORUM_WORK_STATES.join(', ')}, none`,
                },
              };
            }
            patch.state = state === 'none' ? null : (state as ForumWorkState);
          }

          if (action === 'assign' || args.assignee !== undefined) {
            const name = str('assignee');
            if (action === 'assign' && args.assignee === undefined) {
              return { result: { ok: false, error: 'assignee is required for assign' } };
            }
            if (!name) {
              patch.assignee = null;
            } else {
              // Resolved against the same roster that resolves `@name`, so an assignee is always
              // somebody a mention could actually reach. Assigning work to a misremembered name is
              // the silent stall this feature is meant to remove, not reproduce.
              const roster = await loadRoster();
              const target = roster.byName.get(name.toLowerCase());
              if (!target) {
                return {
                  result: {
                    ok: false,
                    error: `no agent named "${name}" — check the roster with annuaire`,
                    known: roster.names,
                  },
                };
              }
              patch.assignee = {
                kind: target.kind,
                agent_id: target.agentId,
                display_name: target.name,
              };
            }
          }

          const updated = await forumService.setWorkState(threadId, author, patch);
          log.info(
            {
              agent: ctx.agentName,
              threadId,
              state: updated.work_state,
              assignee: updated.assignee?.display_name,
            },
            'forum work item updated',
          );
          return {
            result: {
              ok: true,
              thread_id: String(updated._id),
              title: updated.title,
              state: updated.work_state ?? 'none',
              assigned_to: updated.assignee?.display_name ?? null,
              hint:
                updated.assignee && updated.assignee.agent_id !== ctx.agentId
                  ? `Assigning does not wake anyone, and neither does writing @${updated.assignee.display_name} — put that name in \`wake\` on a reply if you need them to start now.`
                  : undefined,
            },
          };
        }

        case 'pin_thread': {
          const threadId = str('thread_id');
          if (!threadId) return { result: { ok: false, error: 'thread_id is required' } };
          const pinned = args.pinned === undefined ? true : Boolean(args.pinned);
          const updated = await forumService.setPinned(threadId, author, pinned);
          return {
            result: { ok: true, thread_id: String(updated._id), title: updated.title, pinned: updated.pinned },
          };
        }

        case 'create_category': {
          if (config.allow_category_creation !== true) {
            return {
              result: {
                ok: false,
                error:
                  'creating categories is disabled — the operator can enable it on the Tools page ' +
                  '(forum → "Agents may create categories"). Post into an existing category instead.',
              },
            };
          }
          const name = str('name');
          if (!name) return { result: { ok: false, error: 'name is required' } };
          if (await forumCategoryRepository.findByIdOrName(name)) {
            return { result: { ok: false, error: `category "${name}" already exists` } };
          }
          const created = await forumCategoryRepository.create({ name, description: str('description') });
          log.info({ agent: ctx.agentName, category: created.name }, 'agent created a forum category');
          return { result: { ok: true, category: created.name } };
        }

        case 'upload_file': {
          const file = await uploadOne(
            ctx,
            {
              handle: str('handle') || undefined,
              path: str('path') || undefined,
              content: args.content != null ? String(args.content) : undefined,
              filename: str('filename') || undefined,
              mime: str('mime') || undefined,
            },
            author,
            attachmentLimits.maxBytes,
          );
          log.info({ agent: ctx.agentName, fileId: String(file._id), filename: file.filename }, 'forum file uploaded');
          return {
            result: {
              ok: true,
              ...shapeFile(file),
              hint: 'Pass this file_id (or the same handle/path) as `attachments` on a post or reply.',
            },
          };
        }

        case 'list_files': {
          const files = await forumFileRepository.list({
            q: str('query') || undefined,
            limit: Number(args.limit) || 25,
          });
          return { result: { ok: true, count: files.length, files: files.map(shapeFile) } };
        }

        case 'get_attachment': {
          const fileId = str('file_id');
          const file = await forumFileRepository.findById(fileId);
          if (!file) return { result: { ok: false, error: `no such file: "${fileId}"` } };
          const bytes = await forumFileRepository.readBytes(fileId);
          if (!bytes) return { result: { ok: false, error: `file "${fileId}" has no stored bytes` } };

          // Copy it into *this* session's resource pool. That is the whole point of the action: from
          // here on it is an ordinary handle, so `analyze_image`, `write from_handle` and `bash` on
          // the written file all work on a teammate's artifact with no forum-specific plumbing.
          const inlineImage = file.kind === 'image' && bytes.length <= MAX_INLINE_IMAGE_BYTES;
          const stored = await resourceRepository.store({
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
            bytes,
            kind: inlineImage ? 'image' : 'blob',
            mime: file.mime,
            filename: file.filename,
            source: 'tool',
          });
          const block: ImageBlock = {
            id: stored.handle,
            kind: inlineImage ? 'image' : 'blob',
            mime: file.mime,
            size: bytes.length,
            filename: file.filename,
            storageId: String(stored.gridfs_id),
            source: 'tool',
            ...(inlineImage ? { dataUrl: `data:${file.mime};base64,${bytes.toString('base64')}` } : {}),
          };
          log.info(
            { agent: ctx.agentName, fileId, handle: stored.handle, size: bytes.length },
            'forum attachment pulled into session',
          );
          return {
            result: {
              ok: true,
              handle: stored.handle,
              filename: file.filename,
              mime: file.mime,
              size: bytes.length,
              kind: inlineImage ? 'image' : 'blob',
              hint: inlineImage
                ? `Use analyze_image with image_id="${stored.handle}" to look at it, or write from_handle to save it.`
                : `Use write with from_handle="${stored.handle}" to save it to a file.`,
            },
            ...(inlineImage ? { images: [block] } : { resources: [block] }),
          };
        }

        default:
          return { result: { ok: false, error: `unknown action: "${action}"` } };
      }
    } catch (err) {
      // Rule violations are the agent's problem to route around, so they come back as results — as
      // is a file it asked to upload that isn't there, or an isolation container that isn't ready.
      if (err instanceof ForumRuleError) return { result: { ok: false, error: err.message } };
      if (err instanceof FileOpError || err instanceof IsolationBlockedError) {
        return { result: { ok: false, error: (err as Error).message } };
      }
      throw err;
    }
  },
};
