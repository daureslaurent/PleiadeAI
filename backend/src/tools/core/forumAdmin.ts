import { createLogger } from '../../config/logger';
import { agentRepository } from '../../domain/agents/agent.repository';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { BUILTIN_FORUM_MODERATOR } from '../../domain/agents/builtin-agents';
import { forumCategoryRepository } from '../../domain/forum/forum-category.repository';
import { forumModeration } from '../../domain/forum/forum-moderation.service';
import { ForumRuleError } from '../../domain/forum/forum.service';
import type { ForumAuthor } from '../../domain/forum/forum-author';
import type { Tool, ToolConfigField, ToolResult } from '../types';

const log = createLogger('tool:forum_admin');

const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'stale_days',
    label: 'Stale after (days)',
    type: 'number',
    default: 45,
    hint: 'A thread with no activity for this long shows up in `audit` as a candidate to archive.',
  },
  {
    key: 'allow_archive',
    label: 'May archive threads',
    type: 'boolean',
    default: true,
    hint: 'Archiving is reversible — an archived thread stays readable and searchable.',
  },
];

/**
 * `forum_admin` — the built-in moderator's privileged verbs (spec `FORUM_PLAN.md` §9).
 *
 * ## Why this is a separate tool, and why it checks the caller
 *
 * Keeping moderation off the ordinary `forum` tool means the other agents never see these actions in
 * their schema at all — no wasted tokens, no refusals to reason about. And every action re-checks
 * that the caller *is* the built-in moderator, so putting `forum_admin` in another agent's
 * `tools_allowed` by accident grants nothing. Authorisation lives in the tool, not in a checkbox.
 *
 * ## Why there is no delete
 *
 * Every verb here is **reversible**: moves, renames and archives undo in a click, and a merge
 * cross-links and locks rather than moving or removing posts, so nothing an agent wrote is ever lost
 * and a thread id already cited in some agent's memory still resolves. Hard deletion is not exposed —
 * `propose_deletion` files a normal thread in the review category and the operator acts on it. That
 * removes the capability rather than asking a model to exercise restraint with it, which is the only
 * version of this guarantee that actually holds at 3am.
 */
export const forumAdmin: Tool = {
  name: 'forum_admin',
  description:
    'Moderator tools for the shared agent forum: refile threads into the right category, retitle ' +
    'unclear threads so they can be found, merge duplicates, archive stale ones, and manage ' +
    'categories. Start with `audit` to see what needs attention. You CANNOT delete anything — use ' +
    '`propose_deletion` to ask the operator, who decides. Prefer the least destructive action that ' +
    'fixes the problem, and leave a thread alone if you are unsure.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'audit',
          'move_thread',
          'rename_thread',
          'merge_threads',
          'archive_thread',
          'unarchive_thread',
          'create_category',
          'update_category',
          'propose_deletion',
        ],
        description: "'audit' lists threads needing attention — run it first.",
      },
      thread_id: { type: 'string', description: 'For move/rename/archive/unarchive.' },
      source_thread_id: { type: 'string', description: 'For `merge_threads`: the duplicate, which gets locked.' },
      target_thread_id: { type: 'string', description: 'For `merge_threads`: the thread that survives.' },
      thread_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'For `propose_deletion`: the threads you want an operator to remove.',
      },
      category: { type: 'string', description: 'For `move_thread` / `update_category`: name or id.' },
      title: { type: 'string', description: 'For `rename_thread`: a specific, searchable title.' },
      name: { type: 'string', description: 'For `create_category`.' },
      description: { type: 'string', description: 'For create/update category: what belongs in it.' },
      agents_can_post: { type: 'boolean', description: 'For `update_category`: make it read-only for agents.' },
      reason: {
        type: 'string',
        description: 'Why. Required for merges and deletion proposals — it is posted for others to read.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  configSchema: CONFIG_SCHEMA,

  async execute(args, ctx): Promise<ToolResult> {
    // Authorisation is re-checked per call against the built-in slug, not against tool grants.
    const agent = await agentRepository.findById(ctx.agentId);
    if (!agent || agent.builtin !== BUILTIN_FORUM_MODERATOR) {
      return {
        result: {
          ok: false,
          error:
            'forum_admin is reserved for the built-in forum moderator. Use the `forum` tool to read ' +
            'and post; ask the moderator if a thread needs refiling.',
        },
      };
    }

    const author: ForumAuthor = { kind: 'agent', agent_id: ctx.agentId, display_name: ctx.agentName };
    const action = String(args.action ?? '').trim();
    const str = (k: string): string => String(args[k] ?? '').trim();

    try {
      switch (action) {
        case 'audit': {
          const { config } = await toolConfigService.resolve(forumAdmin.name, CONFIG_SCHEMA);
          const report = await forumModeration.audit(Number(config.stale_days) || 45);
          return {
            result: {
              ok: true,
              ...report,
              hint:
                'Refile anything in `uncategorised` that clearly belongs elsewhere, retitle vague ' +
                'titles, and consider archiving `stale`. Only propose deletion for genuine junk.',
            },
          };
        }

        case 'move_thread': {
          const thread = await forumModeration.moveThread(str('thread_id'), str('category'));
          return { result: { ok: true, thread_id: String(thread._id), title: thread.title } };
        }

        case 'rename_thread': {
          const title = str('title');
          if (!title) return { result: { ok: false, error: 'title is required' } };
          const thread = await forumModeration.renameThread(str('thread_id'), title);
          return { result: { ok: true, thread_id: String(thread._id), title: thread.title } };
        }

        case 'merge_threads': {
          const reason = str('reason');
          if (!reason) {
            return { result: { ok: false, error: 'reason is required — it is posted in both threads' } };
          }
          const { source, target } = await forumModeration.mergeThreads(
            str('source_thread_id'),
            str('target_thread_id'),
            author,
            reason,
          );
          return {
            result: {
              ok: true,
              locked: String(source._id),
              survivor: String(target._id),
              note: 'Both threads remain readable and searchable; nothing was deleted.',
            },
          };
        }

        case 'archive_thread':
        case 'unarchive_thread': {
          const archiving = action === 'archive_thread';
          const { config } = await toolConfigService.resolve(forumAdmin.name, CONFIG_SCHEMA);
          if (archiving && config.allow_archive !== true) {
            return { result: { ok: false, error: 'archiving is disabled by the operator on the Tools page' } };
          }
          const thread = await forumModeration.setArchived(str('thread_id'), archiving);
          return { result: { ok: true, thread_id: String(thread._id), status: thread.status } };
        }

        case 'create_category': {
          const name = str('name');
          if (!name) return { result: { ok: false, error: 'name is required' } };
          if (await forumCategoryRepository.findByIdOrName(name)) {
            return { result: { ok: false, error: `category "${name}" already exists` } };
          }
          const created = await forumCategoryRepository.create({ name, description: str('description') });
          log.info({ category: created.name }, 'moderator created a category');
          return { result: { ok: true, category: created.name, category_id: String(created._id) } };
        }

        case 'update_category': {
          const category = await forumCategoryRepository.findByIdOrName(str('category'));
          if (!category) return { result: { ok: false, error: `no such category: "${str('category')}"` } };
          const patch: Record<string, unknown> = {};
          if (str('description')) patch.description = str('description');
          if (typeof args.agents_can_post === 'boolean') patch.agents_can_post = args.agents_can_post;
          if (!Object.keys(patch).length) {
            return { result: { ok: false, error: 'nothing to update' } };
          }
          const updated = await forumCategoryRepository.update(String(category._id), patch);
          return { result: { ok: true, category: updated!.name } };
        }

        case 'propose_deletion': {
          const ids = Array.isArray(args.thread_ids) ? args.thread_ids.map(String) : [];
          const reason = str('reason');
          if (!ids.length) return { result: { ok: false, error: 'thread_ids is required' } };
          if (!reason) return { result: { ok: false, error: 'reason is required — the operator reads it' } };
          const proposal = await forumModeration.proposeDeletion(ids, reason, author);
          return {
            result: {
              ok: true,
              ...proposal,
              note: 'Filed for the operator. Nothing has been deleted; do not propose these again.',
            },
          };
        }

        default:
          return { result: { ok: false, error: `unknown action: "${action}"` } };
      }
    } catch (err) {
      if (err instanceof ForumRuleError) return { result: { ok: false, error: err.message } };
      throw err;
    }
  },
};
