import { createLogger } from '../../../config/logger';
import { GitLabError, request } from '../../../domain/gitlab/gitlab.service';
import { actionParam, agentConnection, guard, readOnly, unknownAction } from './shared';
import type { Tool } from '../../types';

const log = createLogger('tool:gitlab');

const TODO_ACTIONS = ['list', 'done'];

/**
 * `gitlab_todo` — what GitLab has aimed at *this agent* (`GITLAB_PLAN.md` §14).
 *
 * GitLab keeps a per-account to-do list, and §11 gave every agent its own account, so this is the
 * one question the fleet could not previously ask: not "what is open in this project" but "what is
 * waiting on me". An assignment, a review request, a mention, a pipeline that broke on my merge
 * request — GitLab has already decided each of those is mine, and the poller (§13) reads exactly
 * this list from the outside to decide whom to wake.
 *
 * Which makes the tool the agent's own copy of the poller's input, and that matters when polling is
 * off: an agent on a cron tick can look for itself rather than waiting to be woken.
 *
 * `done` is how a list stays meaningful. A to-do that is never cleared is indistinguishable from
 * one that arrived a minute ago, and the agent that answered the comment is the only thing that
 * knows the difference.
 */
export const gitlabTodo: Tool = {
  name: 'gitlab_todo',
  parallelSafe: readOnly('list'),
  description:
    'Your own GitLab to-do list — what has been aimed at your account: issues assigned to you, ' +
    'reviews requested from you, comments naming you, your merge requests that broke or can no ' +
    'longer merge. `list` (optional `type` to keep only Issue or MergeRequest ones, `limit`). ' +
    '`done` (`todo_id`, or `all:true`) clears them once you have acted. This is the right first ' +
    'call when you are asked what you should be working on — it is GitLab\'s own answer, not a ' +
    'guess from a project listing.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', TODO_ACTIONS),
      type: {
        type: 'string',
        enum: ['Issue', 'MergeRequest'],
        description: '`list`: keep only to-dos about issues, or only about merge requests.',
      },
      todo_id: { type: 'number', description: '`done`: the to-do to clear (its `id` from `list`).' },
      all: { type: 'boolean', description: '`done`: clear every pending to-do instead of one.' },
      limit: { type: 'number', description: '`list`: how many (default 30, max 100).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const conn = await agentConnection(ctx);
      log.info({ agent: ctx.agentName, action, actingAs: conn.actingAs }, 'gitlab_todo');

      switch (action) {
        case 'list': {
          const rows = await request<Record<string, any>[]>('todos', {
            conn,
            paginate: Math.min(100, Math.max(1, Number(args.limit) || 30)),
            query: { state: 'pending', type: args.type },
          });
          // Group scoping is a guard everywhere else in this tool family, and a to-do list spans
          // every project the account can see — so it is re-applied here rather than trusted.
          const scope = conn.group.toLowerCase();
          const inScope = (path: string) =>
            !scope || path.toLowerCase() === scope || path.toLowerCase().startsWith(`${scope}/`);

          const todos = rows
            .map((t) => ({
              id: Number(t.id),
              /** `assigned`, `review_requested`, `mentioned`, `build_failed`, `unmergeable`… */
              reason: String(t.action_name ?? ''),
              project: String(t.project?.path_with_namespace ?? ''),
              target: `${String(t.target_type) === 'MergeRequest' ? '!' : '#'}${t.target?.iid ?? ''} ${
                t.target?.title ?? ''
              }`.trim(),
              target_type: String(t.target_type ?? ''),
              iid: t.target?.iid ?? null,
              from: String(t.author?.username ?? ''),
              /** The comment or description that created it — often the whole question. */
              body: String(t.body ?? '').slice(0, 500),
              url: String(t.target_url ?? ''),
              at: String(t.created_at ?? ''),
            }))
            .filter((t) => inScope(t.project));

          return {
            acting_as: conn.actingAs ?? conn.botUsername ?? 'the fleet account',
            count: todos.length,
            todos,
          };
        }

        case 'done': {
          if (args.all === true) {
            await request('todos/mark_as_done', { conn, method: 'POST' });
            return { cleared: 'all' };
          }
          const id = Number(args.todo_id);
          if (!Number.isFinite(id)) {
            throw new GitLabError('`todo_id` is required — the `id` from `list`, or pass `all: true`');
          }
          await request(`todos/${id}/mark_as_done`, { conn, method: 'POST' });
          return { cleared: id };
        }

        default:
          return unknownAction(action, TODO_ACTIONS);
      }
    });
  },
};
