import { createLogger } from '../../../config/logger';
import {
  GitLabError,
  connection,
  request,
  scopedPath,
  slimIssue,
  slimMergeRequest,
} from '../../../domain/gitlab/gitlab.service';
import {
  PROJECT_PARAM,
  actionParam,
  clip,
  guard,
  logWrite,
  project,
  readOnly,
  unknownAction,
} from './shared';
import type { Tool } from '../../types';

const log = createLogger('tool:gitlab');

const MAX_DIFF_CHARS = 40_000;

const ISSUE_ACTIONS = ['list', 'get', 'create', 'update', 'comment', 'close', 'reopen'];

/**
 * `gitlab_issue` — the fleet's work board (`GITLAB_PLAN.md` §0).
 *
 * This is the tool that replaces what the removed `board` did, and it replaces it with something
 * better for one reason: the operator is already in GitLab. A task an agent claims here shows up in
 * the same list as the tasks the humans claim, with the same notifications and the same history,
 * instead of in a parallel board only the fleet can see.
 *
 * Which is why `list` defaults to *open* issues and why `assignee` is a first-class argument: the
 * two questions an agent actually asks are "what is there to do" and "what is mine".
 */
export const gitlabIssue: Tool = {
  name: 'gitlab_issue',
  parallelSafe: readOnly('list', 'get'),
  description:
    'Work with GitLab issues — this is the fleet\'s work board. `list` (optional `project`, ' +
    '`assignee`, `labels`, `state`, `search`) → issues, open ones by default; omit `project` to see ' +
    'them across every project. `get` (`iid`) → one issue with its description. `create` (`title`, ' +
    '`description`, `labels`, `assignee`) → a new issue. `update` (`iid` + any of title/description/' +
    'labels/assignee/due_date) → change one. `comment` (`iid`, `body`) → post a note. `close` / ' +
    '`reopen`. To claim a piece of work, assign the issue to yourself and say so in a comment; when ' +
    'you finish, comment what you did and close it.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', ISSUE_ACTIONS),
      project: PROJECT_PARAM,
      iid: { type: 'number', description: 'The issue number within its project (the #N you see in GitLab).' },
      title: { type: 'string', description: '`create`/`update`: the issue title.' },
      description: { type: 'string', description: '`create`/`update`: the body, Markdown.' },
      body: { type: 'string', description: '`comment`: the comment text, Markdown.' },
      assignee: {
        type: 'string',
        description: 'GitLab username to assign (`update`/`create`), or to filter by (`list`). "none" clears it.',
      },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to set or filter by.' },
      state: { type: 'string', enum: ['opened', 'closed', 'all'], description: '`list`: default opened.' },
      search: { type: 'string', description: '`list`: match title and description.' },
      due_date: { type: 'string', description: '`update`: YYYY-MM-DD, or "" to clear.' },
      limit: { type: 'number', description: '`list`: how many (default 30, max 100).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const iid = Number(args.iid);
      log.info({ agent: ctx.agentName, action, project: args.project, iid }, 'gitlab_issue');

      // `list` is the one action that may span every project — "what is on my plate" is not a
      // question about one repository.
      if (action === 'list') {
        const hasProject = !!String(args.project ?? '').trim();
        // Resolved once: `project()` validates the group scope *and* opens the connection, and doing
        // it twice would cost two settings reads to answer one question.
        const scopeRef = hasProject ? await project(args) : null;
        const conn = scopeRef?.conn ?? (await connection());
        const path = scopeRef ? `projects/${scopeRef.id}/issues` : scopedPath(conn, 'issues', 'issues');
        const rows = await request<Record<string, any>[]>(path, {
          conn,
          paginate: Math.min(100, Math.max(1, Number(args.limit) || 30)),
          query: {
            state: String(args.state ?? 'opened') === 'all' ? undefined : String(args.state ?? 'opened'),
            assignee_username: args.assignee,
            labels: Array.isArray(args.labels) ? args.labels.join(',') : args.labels,
            search: args.search,
            scope: hasProject ? undefined : 'all',
            order_by: 'updated_at',
          },
        });
        return { count: rows.length, issues: rows.map(slimIssue) };
      }

      const { conn, id, path } = await project(args);
      const needsIid = ['get', 'update', 'comment', 'close', 'reopen'];
      if (needsIid.includes(action) && !Number.isFinite(iid)) {
        throw new GitLabError('`iid` is required — the issue number within its project');
      }

      switch (action) {
        case 'get': {
          const i = await request<Record<string, any>>(`projects/${id}/issues/${iid}`, { conn });
          return { issue: slimIssue(i) };
        }

        case 'create': {
          const title = String(args.title ?? '').trim();
          if (!title) throw new GitLabError('`title` is required');
          const created = await request<Record<string, any>>(`projects/${id}/issues`, {
            conn,
            method: 'POST',
            body: {
              title,
              description: args.description,
              labels: Array.isArray(args.labels) ? args.labels.join(',') : args.labels,
              assignee_ids: await resolveAssignees(args.assignee, conn),
            },
          });
          logWrite(ctx, path, 'gitlab_issue.create', {
            target: `#${created.iid}`,
            title,
            url: created.web_url,
          });
          return { issue: slimIssue(created) };
        }

        case 'update': {
          const body: Record<string, unknown> = {};
          if (typeof args.title === 'string') body.title = args.title;
          if (typeof args.description === 'string') body.description = args.description;
          if (args.labels !== undefined) {
            body.labels = Array.isArray(args.labels) ? args.labels.join(',') : args.labels;
          }
          if (args.due_date !== undefined) body.due_date = args.due_date;
          if (args.assignee !== undefined) body.assignee_ids = await resolveAssignees(args.assignee, conn);
          if (!Object.keys(body).length) throw new GitLabError('nothing to update — pass at least one field');
          const updated = await request<Record<string, any>>(`projects/${id}/issues/${iid}`, {
            conn,
            method: 'PUT',
            body,
          });
          logWrite(ctx, path, 'gitlab_issue.update', {
            target: `#${iid}`,
            title: String(updated.title ?? ''),
            url: updated.web_url,
          });
          return { issue: slimIssue(updated) };
        }

        case 'comment': {
          const body = String(args.body ?? '').trim();
          if (!body) throw new GitLabError('`body` is required — the comment text');
          const note = await request<Record<string, any>>(`projects/${id}/issues/${iid}/notes`, {
            conn,
            method: 'POST',
            body: { body },
          });
          logWrite(ctx, path, 'gitlab_issue.comment', {
            target: `#${iid}`,
            title: body.split('\n')[0],
            url: `${conn.url}/${path}/-/issues/${iid}#note_${note.id}`,
          });
          return { commented: true, issue: iid, note_id: note.id };
        }

        case 'close':
        case 'reopen': {
          const updated = await request<Record<string, any>>(`projects/${id}/issues/${iid}`, {
            conn,
            method: 'PUT',
            body: { state_event: action },
          });
          logWrite(ctx, path, `gitlab_issue.${action}`, {
            target: `#${iid}`,
            title: String(updated.title ?? ''),
            url: updated.web_url,
          });
          return { issue: slimIssue(updated) };
        }

        default:
          return unknownAction(action, ISSUE_ACTIONS);
      }
    });
  },
};

const MR_ACTIONS = ['list', 'get', 'create', 'update', 'diff', 'discussions', 'comment', 'approve', 'merge', 'close'];

/**
 * `gitlab_mr` — propose, review and land changes.
 *
 * The operator asked for full write, merge included, and this tool has it. The brake is not in the
 * code: it is the bot account's own GitLab permissions, which is the right place for it — a project
 * the fleet may propose to but not land on is expressed by giving the account Developer instead of
 * Maintainer *there*, per project, by the person who owns that project. A hard-coded refusal here
 * would apply that judgement uniformly to repositories it has never seen.
 */
export const gitlabMr: Tool = {
  name: 'gitlab_mr',
  parallelSafe: readOnly('list', 'get', 'diff', 'discussions'),
  description:
    'Work with GitLab merge requests. `list` (optional `project`, `state`, `author`, `reviewer`) → ' +
    'MRs, open by default, across every project when no `project` is given. `get` (`iid`) → one, with ' +
    'its merge status and head pipeline. `create` (`source_branch`, `title`, optional `target_branch`, ' +
    '`description`, `reviewer`, `draft`, `remove_source_branch`). `diff` (`iid`) → the whole change. ' +
    '`discussions` (`iid`) → the review threads. `comment` (`iid`, `body`, optional `path`+`line` to ' +
    'anchor it to code). `approve`. `merge` (`iid`, optional `squash`, `when_pipeline_succeeds`). ' +
    '`close`. Read `diff` before approving or merging anything.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', MR_ACTIONS),
      project: PROJECT_PARAM,
      iid: { type: 'number', description: 'The merge request number within its project (the !N in GitLab).' },
      source_branch: { type: 'string', description: '`create`: the branch holding the change.' },
      target_branch: { type: 'string', description: '`create`: where it merges into (default: the default branch).' },
      title: { type: 'string', description: '`create`/`update`: the MR title.' },
      description: { type: 'string', description: '`create`/`update`: the body — what changed and how you verified it.' },
      body: { type: 'string', description: '`comment`: the comment text.' },
      path: { type: 'string', description: '`comment`: file path to anchor the comment to.' },
      line: { type: 'number', description: '`comment`: line in `path` (new-side) to anchor to.' },
      reviewer: { type: 'string', description: '`create`/`update`: GitLab username to request review from; `list`: filter.' },
      author: { type: 'string', description: '`list`: filter by author username.' },
      state: { type: 'string', enum: ['opened', 'merged', 'closed', 'all'], description: '`list`: default opened.' },
      draft: { type: 'boolean', description: '`create`: open it as a draft.' },
      squash: { type: 'boolean', description: '`merge`: squash the commits.' },
      when_pipeline_succeeds: { type: 'boolean', description: '`merge`: queue the merge behind a green pipeline.' },
      remove_source_branch: { type: 'boolean', description: '`create`/`merge`: delete the branch after merging.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to set or filter by.' },
      limit: { type: 'number', description: '`list`: how many (default 30, max 100).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const iid = Number(args.iid);
      log.info({ agent: ctx.agentName, action, project: args.project, iid }, 'gitlab_mr');

      if (action === 'list') {
        const hasProject = !!String(args.project ?? '').trim();
        const scopeRef = hasProject ? await project(args) : null;
        const conn = scopeRef?.conn ?? (await connection());
        const path = scopeRef
          ? `projects/${scopeRef.id}/merge_requests`
          : scopedPath(conn, 'merge_requests', 'merge_requests');
        const rows = await request<Record<string, any>[]>(path, {
          conn,
          paginate: Math.min(100, Math.max(1, Number(args.limit) || 30)),
          query: {
            state: String(args.state ?? 'opened') === 'all' ? undefined : String(args.state ?? 'opened'),
            author_username: args.author,
            reviewer_username: args.reviewer,
            labels: Array.isArray(args.labels) ? args.labels.join(',') : args.labels,
            scope: hasProject ? undefined : 'all',
            order_by: 'updated_at',
          },
        });
        return { count: rows.length, merge_requests: rows.map(slimMergeRequest) };
      }

      const { conn, id, path } = await project(args);
      const needsIid = ['get', 'update', 'diff', 'discussions', 'comment', 'approve', 'merge', 'close'];
      if (needsIid.includes(action) && !Number.isFinite(iid)) {
        throw new GitLabError('`iid` is required — the merge request number within its project');
      }

      switch (action) {
        case 'get': {
          const m = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}`, { conn });
          return { merge_request: slimMergeRequest(m) };
        }

        case 'create': {
          const source = String(args.source_branch ?? '').trim();
          const title = String(args.title ?? '').trim();
          if (!source) throw new GitLabError('`source_branch` is required — the branch holding your change');
          if (!title) throw new GitLabError('`title` is required');
          let target = String(args.target_branch ?? '').trim();
          if (!target) {
            const p = await request<Record<string, any>>(`projects/${id}`, { conn });
            target = p.default_branch;
          }
          const created = await request<Record<string, any>>(`projects/${id}/merge_requests`, {
            conn,
            method: 'POST',
            body: {
              source_branch: source,
              target_branch: target,
              title: args.draft ? `Draft: ${title}` : title,
              description: args.description,
              reviewer_ids: await resolveAssignees(args.reviewer, conn),
              labels: Array.isArray(args.labels) ? args.labels.join(',') : args.labels,
              remove_source_branch: args.remove_source_branch ?? true,
            },
          });
          logWrite(ctx, path, 'gitlab_mr.create', {
            target: `!${created.iid}`,
            title,
            url: created.web_url,
          });
          return { merge_request: slimMergeRequest(created) };
        }

        case 'update': {
          const body: Record<string, unknown> = {};
          if (typeof args.title === 'string') body.title = args.title;
          if (typeof args.description === 'string') body.description = args.description;
          if (typeof args.target_branch === 'string') body.target_branch = args.target_branch;
          if (args.labels !== undefined) {
            body.labels = Array.isArray(args.labels) ? args.labels.join(',') : args.labels;
          }
          if (args.reviewer !== undefined) body.reviewer_ids = await resolveAssignees(args.reviewer, conn);
          if (!Object.keys(body).length) throw new GitLabError('nothing to update — pass at least one field');
          const updated = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}`, {
            conn,
            method: 'PUT',
            body,
          });
          logWrite(ctx, path, 'gitlab_mr.update', { target: `!${iid}`, title: String(updated.title ?? ''), url: updated.web_url });
          return { merge_request: slimMergeRequest(updated) };
        }

        case 'diff': {
          const m = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}/changes`, { conn });
          const rows: Record<string, any>[] = m.changes ?? [];
          const patch = rows.map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff ?? ''}`).join('\n');
          const { text, truncated } = clip(patch, MAX_DIFF_CHARS);
          return {
            merge_request: slimMergeRequest(m),
            files: rows.map((d) => d.new_path),
            truncated,
            diff: text,
          };
        }

        case 'discussions': {
          const rows = await request<Record<string, any>[]>(
            `projects/${id}/merge_requests/${iid}/discussions`,
            { conn, paginate: 100 },
          );
          return {
            count: rows.length,
            discussions: rows.map((d) => ({
              id: d.id,
              resolved: d.notes?.[0]?.resolved ?? false,
              // A review thread's anchor is the whole point of reading it: an unanchored "this is
              // wrong" is unactionable, `src/auth.ts:42` is a task.
              anchor: d.notes?.[0]?.position
                ? `${d.notes[0].position.new_path}:${d.notes[0].position.new_line}`
                : null,
              notes: (d.notes ?? []).map((n: any) => ({
                author: n.author?.username,
                body: n.body,
                at: n.created_at,
                system: n.system,
              })),
            })),
          };
        }

        case 'comment': {
          const body = String(args.body ?? '').trim();
          if (!body) throw new GitLabError('`body` is required');
          const anchorPath = String(args.path ?? '').trim();
          const line = Number(args.line);
          let note: Record<string, any>;
          if (anchorPath && Number.isFinite(line)) {
            // An anchored comment needs the MR's diff refs — the three SHAs GitLab positions
            // against. Fetched rather than guessed: a stale base SHA is rejected outright.
            const m = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}`, { conn });
            note = await request<Record<string, any>>(
              `projects/${id}/merge_requests/${iid}/discussions`,
              {
                conn,
                method: 'POST',
                body: {
                  body,
                  position: {
                    base_sha: m.diff_refs?.base_sha,
                    head_sha: m.diff_refs?.head_sha,
                    start_sha: m.diff_refs?.start_sha,
                    position_type: 'text',
                    new_path: anchorPath,
                    new_line: line,
                  },
                },
              },
            );
          } else {
            note = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}/notes`, {
              conn,
              method: 'POST',
              body: { body },
            });
          }
          logWrite(ctx, path, 'gitlab_mr.comment', {
            target: `!${iid}`,
            title: body.split('\n')[0],
            url: `${conn.url}/${path}/-/merge_requests/${iid}`,
          });
          return { commented: true, merge_request: iid, anchored: !!anchorPath };
        }

        case 'approve': {
          await request(`projects/${id}/merge_requests/${iid}/approve`, { conn, method: 'POST' });
          logWrite(ctx, path, 'gitlab_mr.approve', {
            target: `!${iid}`,
            title: 'approved',
            url: `${conn.url}/${path}/-/merge_requests/${iid}`,
          });
          return { approved: true, merge_request: iid };
        }

        case 'merge': {
          const merged = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}/merge`, {
            conn,
            method: 'PUT',
            body: {
              squash: args.squash ?? undefined,
              should_remove_source_branch: args.remove_source_branch ?? undefined,
              merge_when_pipeline_succeeds: args.when_pipeline_succeeds ?? undefined,
            },
          });
          logWrite(ctx, path, 'gitlab_mr.merge', {
            target: `!${iid}`,
            title: String(merged.title ?? ''),
            url: merged.web_url,
          });
          return { merge_request: slimMergeRequest(merged) };
        }

        case 'close': {
          const closed = await request<Record<string, any>>(`projects/${id}/merge_requests/${iid}`, {
            conn,
            method: 'PUT',
            body: { state_event: 'close' },
          });
          logWrite(ctx, path, 'gitlab_mr.close', { target: `!${iid}`, title: String(closed.title ?? ''), url: closed.web_url });
          return { merge_request: slimMergeRequest(closed) };
        }

        default:
          return unknownAction(action, MR_ACTIONS);
      }
    });
  },
};

/**
 * Turn a username into the user-id array GitLab's assignee/reviewer fields want.
 *
 * `'none'`/`''` clears the field — an empty array is how GitLab expresses "nobody", and the agent
 * needs a way to say it that isn't "omit the argument" (which means "leave it alone").
 */
async function resolveAssignees(
  username: unknown,
  conn: Awaited<ReturnType<typeof connection>>,
): Promise<number[] | undefined> {
  if (username === undefined) return undefined;
  const name = String(username ?? '').trim().replace(/^@/, '');
  if (!name || name.toLowerCase() === 'none') return [];
  const users = await request<Record<string, any>[]>('users', { conn, query: { username: name } });
  if (!users.length) throw new GitLabError(`no GitLab user called "${name}"`);
  return [users[0]!.id];
}
