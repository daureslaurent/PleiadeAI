import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { forumCategoryRepository } from '../../domain/forum/forum-category.repository';
import { forumThreadRepository } from '../../domain/forum/forum-thread.repository';
import { forumPostRepository } from '../../domain/forum/forum-post.repository';
import { forumService, ForumRuleError, type ForumSearchMode } from '../../domain/forum/forum.service';
import type { ForumAuthor } from '../../domain/forum/forum-author';
import type { Tool, ToolConfigField, ToolResult } from '../types';

const log = createLogger('tool:forum');

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
    key: 'duplicate_threshold',
    label: 'Duplicate-thread cutoff',
    type: 'number',
    default: 0.88,
    hint: 'A new thread this similar to an existing one is refused until the agent passes force=true.',
  },
];

/** Hard ceiling on `read_thread`, independent of what the agent asks for. See the tool JSDoc. */
const MAX_POSTS_PER_READ = 30;

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
    'ALWAYS `search` before you `post_thread` — the answer is often already on the board, and posting ' +
    'a duplicate is worse than not posting. Cite the thread id when you build on something you read. ' +
    'Post findings that will still matter next week (causes, fixes, gotchas), not turn-by-turn chatter.',
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
          'create_category',
        ],
        description:
          "'search' finds existing threads (do this first); 'read_thread' opens one; 'post_thread' " +
          "starts a new topic; 'reply' adds to an existing one; 'edit_post' revises your own post.",
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
          'are guessing — other agents will act on this.',
      },
      reply_to: { type: 'string', description: 'For `reply`: the post id you are answering.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'For `post_thread`: optional labels.' },
      force: {
        type: 'boolean',
        description: 'For `post_thread`: post anyway after reviewing the similar threads it reported.',
      },
      name: { type: 'string', description: 'For `create_category`.' },
      description: { type: 'string', description: 'For `create_category`: what belongs in it.' },
      limit: { type: 'number', description: 'Page size for `search`/`list_threads`/`read_thread`.' },
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

    /** Identity is taken from the run, never from `args` — an agent cannot post as someone else. */
    const author: ForumAuthor = {
      kind: 'agent',
      agent_id: ctx.agentId,
      display_name: ctx.agentName,
    };

    const action = String(args.action ?? '').trim();
    const str = (key: string): string => String(args[key] ?? '').trim();

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
          const threads = await forumThreadRepository.list({
            categoryId: resolved ? String(resolved._id) : undefined,
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
          const remaining = Math.max(0, total - (offset + posts.length));
          return {
            result: {
              ok: true,
              thread_id: String(thread._id),
              title: thread.title,
              status: thread.status,
              tags: thread.tags.length ? thread.tags : undefined,
              resolved_post_id: thread.resolved_post_id ? String(thread.resolved_post_id) : undefined,
              total_posts: total,
              posts: posts.map((p) => ({
                post_id: String(p._id),
                author: p.author.display_name,
                created_at: p.created_at.toISOString(),
                body: p.body,
                in_reply_to: p.reply_to ? String(p.reply_to) : undefined,
                edited: p.edited_at ? true : undefined,
              })),
              // Explicit, so the model knows it is looking at a page and can ask for the next one.
              ...(remaining
                ? { truncated: true, remaining, next_offset: offset + posts.length }
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

          const { thread, post } = await forumService.createThread({
            category,
            title,
            body,
            author,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
            byAgent: true,
          });
          log.info({ agent: ctx.agentName, threadId: String(thread._id) }, 'agent opened a forum thread');
          return {
            result: { ok: true, thread_id: String(thread._id), post_id: String(post._id), title: thread.title },
          };
        }

        case 'reply': {
          const threadId = str('thread_id');
          const body = str('body');
          if (!threadId || !body) return { result: { ok: false, error: 'thread_id and body are required' } };
          const thread = await forumService.requireOpenThread(threadId);
          const post = await forumService.addPost({
            thread,
            body,
            author,
            replyTo: str('reply_to') || null,
          });
          return {
            result: { ok: true, post_id: String(post._id), thread_id: threadId, title: thread.title },
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
          await forumService.editPost(post, body, ctx.agentName);
          return { result: { ok: true, post_id: postId } };
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

        default:
          return { result: { ok: false, error: `unknown action: "${action}"` } };
      }
    } catch (err) {
      // Rule violations are the agent's problem to route around, so they come back as results.
      if (err instanceof ForumRuleError) return { result: { ok: false, error: err.message } };
      throw err;
    }
  },
};
