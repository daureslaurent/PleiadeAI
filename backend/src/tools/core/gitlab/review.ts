import { createLogger } from '../../../config/logger';
import {
  GitLabError,
  request,
  type GitLabConnection,
  scopedPath,
  slimCommit,
  slimIssue,
  slimMergeRequest,
} from '../../../domain/gitlab/gitlab.service';
import { issueLinks, itemStory, mrApprovals } from '../../../domain/gitlab/gitlab-item.service';
import { assertItemRead, markItemRead } from '../../../domain/gitlab/gitlab-read-guard';
import {
  PROJECT_PARAM,
  actionParam,
  agentConnection,
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

const ISSUE_ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'comment',
  'reply',
  'close',
  'reopen',
  'link',
  'time',
  'subscribe',
];

/** Writes that are refused on an item this turn has not read (`GITLAB_PLAN.md` §14). */
const ISSUE_READ_FIRST = new Set(['comment', 'reply', 'close', 'reopen']);
const MR_READ_FIRST = new Set(['comment', 'reply', 'resolve', 'approve', 'unapprove', 'merge', 'close']);

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
 *
 * **`get` returns the conversation, not just the description** (§14). It used to return the
 * description alone, which meant an agent could read an issue, never see the four comments on it,
 * and answer a question settled two days ago — there was no call that would have shown it. There is
 * now no call that hides it either: the thread, the state changes, the label churn and the merge
 * requests pointing at it come back together, and commenting or closing without that read is
 * refused.
 *
 * GitLab 19 calls these **work items** in its UI and URLs. It is the same object and the same API.
 */
export const gitlabIssue: Tool = {
  name: 'gitlab_issue',
  parallelSafe: readOnly('list', 'get'),
  description:
    'Work with GitLab issues — the fleet\'s work board (GitLab 19 calls them "work items"; same ' +
    'thing). `list` (optional `project`, `assignee`, `labels`, `state`, `search`) → issues, open by ' +
    'default; omit `project` for every project. `get` (`iid`) → **the whole item**: description, ' +
    'every comment and state/label change oldest-first, and the merge requests and issues linked to ' +
    'it. `create` (`title`, `description`, `labels`, `assignee`). `update` (`iid` + title/' +
    'description/labels/assignee/due_date). `comment` (`iid`, `body`) → a new thread. `reply` ' +
    '(`iid`, `thread_id`, `body`) → answer inside an existing one. `close` / `reopen`. `link` ' +
    '(`iid`, `target_iid`, `link_type`) → relate two issues. `time` (`spend` and/or `estimate`, ' +
    'e.g. "90m"). `subscribe`. **You must `get` an issue before you may comment on, close or reopen ' +
    'it** — somebody may already have answered. Claim work by assigning it to yourself and saying ' +
    'so; finish by commenting what you did and closing.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', ISSUE_ACTIONS),
      project: PROJECT_PARAM,
      iid: { type: 'number', description: 'The issue number within its project (the #N you see in GitLab).' },
      title: { type: 'string', description: '`create`/`update`: the issue title.' },
      description: { type: 'string', description: '`create`/`update`: the body, Markdown.' },
      body: { type: 'string', description: '`comment`/`reply`: the text, Markdown.' },
      thread_id: {
        type: 'string',
        description:
          '`reply`: which thread to answer in — the `thread_id` shown on that entry of `get`\'s ' +
          'timeline. Without it a reply is just another orphan comment.',
      },
      assignee: {
        type: 'string',
        description: 'GitLab username to assign (`update`/`create`), or to filter by (`list`). "none" clears it.',
      },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels to set or filter by.' },
      state: { type: 'string', enum: ['opened', 'closed', 'all'], description: '`list`: default opened.' },
      search: { type: 'string', description: '`list`: match title and description.' },
      due_date: { type: 'string', description: '`update`: YYYY-MM-DD, or "" to clear.' },
      target_iid: { type: 'number', description: '`link`: the other issue\'s number.' },
      target_project: { type: 'string', description: '`link`: the other issue\'s project, if not this one.' },
      link_type: {
        type: 'string',
        enum: ['relates_to', 'blocks', 'is_blocked_by'],
        description: '`link`: how they relate (default relates_to).',
      },
      spend: { type: 'string', description: '`time`: time spent to add, e.g. "1h30m" (negative subtracts).' },
      estimate: { type: 'string', description: '`time`: the estimate to set, e.g. "3h".' },
      subscribed: { type: 'boolean', description: '`subscribe`: false to unsubscribe (default true).' },
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
        const scopeRef = hasProject ? await project(args, ctx) : null;
        const conn = scopeRef?.conn ?? (await agentConnection(ctx));
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

      const { conn, id, path } = await project(args, ctx);
      const needsIid = ['get', 'update', 'comment', 'reply', 'close', 'reopen', 'link', 'time', 'subscribe'];
      if (needsIid.includes(action) && !Number.isFinite(iid)) {
        throw new GitLabError('`iid` is required — the issue number within its project');
      }
      if (ISSUE_READ_FIRST.has(action)) assertItemRead(ctx, path, 'issue', iid, action);

      switch (action) {
        case 'get': {
          // Four calls, in parallel, and they are the point of this action: the issue alone is a
          // title and a description, which is exactly the half that does not tell you whether the
          // question has already been answered or somebody has a branch open against it.
          const [i, story, links] = await Promise.all([
            request<Record<string, any>>(`projects/${id}/issues/${iid}`, { conn }),
            itemStory({ conn, id, kind: 'issues', iid }),
            issueLinks({ conn, id, iid }),
          ]);
          markItemRead(ctx, path, 'issue', iid);
          return {
            issue: slimIssue(i),
            time: i.time_stats ?? null,
            comments: story.comments,
            unresolved_threads: story.unresolved,
            omitted_entries: story.omitted,
            timeline: story.timeline,
            linked: links,
          };
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
          // Nothing said on it yet, so the read rule is already satisfied — refusing the author's
          // own follow-up comment would be pedantry, not safety.
          markItemRead(ctx, path, 'issue', Number(created.iid));
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

        case 'comment':
        case 'reply': {
          const body = String(args.body ?? '').trim();
          if (!body) throw new GitLabError('`body` is required — the comment text');
          const threadId = String(args.thread_id ?? '').trim();
          if (action === 'reply' && !threadId) {
            throw new GitLabError(
              '`thread_id` is required for `reply` — take it from the timeline entry you are ' +
                'answering (`get`). To start a new thread instead, use `comment`.',
            );
          }
          const note = threadId
            ? await request<Record<string, any>>(
                `projects/${id}/issues/${iid}/discussions/${encodeURIComponent(threadId)}/notes`,
                { conn, method: 'POST', body: { body } },
              )
            : await request<Record<string, any>>(`projects/${id}/issues/${iid}/notes`, {
                conn,
                method: 'POST',
                body: { body },
              });
          logWrite(ctx, path, `gitlab_issue.${action}`, {
            target: `#${iid}`,
            title: body.split('\n')[0],
            url: `${conn.url}/${path}/-/issues/${iid}#note_${note.id}`,
          });
          return { commented: true, issue: iid, note_id: note.id, in_thread: threadId || null };
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

        case 'link': {
          const targetIid = Number(args.target_iid);
          if (!Number.isFinite(targetIid)) throw new GitLabError('`target_iid` is required — the other issue');
          const targetProject = String(args.target_project ?? '').trim();
          // The other issue's *project* is a separate argument to GitLab, and it is resolved through
          // the same group guard as any other project reference — a link must not be the way an
          // argument reaches outside the namespace.
          const targetId = targetProject ? (await project({ project: targetProject }, ctx)).id : id;
          const link = await request<Record<string, any>>(`projects/${id}/issues/${iid}/links`, {
            conn,
            method: 'POST',
            body: {
              target_project_id: decodeURIComponent(targetId),
              target_issue_iid: targetIid,
              link_type: String(args.link_type ?? 'relates_to'),
            },
          });
          logWrite(ctx, path, 'gitlab_issue.link', {
            target: `#${iid}`,
            title: `${args.link_type ?? 'relates_to'} #${targetIid}`,
            url: String(link.web_url ?? ''),
          });
          return { linked: true, issue: iid, to: targetIid, link_type: args.link_type ?? 'relates_to' };
        }

        case 'time': {
          const spend = String(args.spend ?? '').trim();
          const estimate = String(args.estimate ?? '').trim();
          if (!spend && !estimate) throw new GitLabError('pass `spend`, `estimate`, or both — e.g. "90m"');
          if (estimate) {
            await request(`projects/${id}/issues/${iid}/time_estimate`, {
              conn,
              method: 'POST',
              body: { duration: estimate },
            });
          }
          if (spend) {
            await request(`projects/${id}/issues/${iid}/add_spent_time`, {
              conn,
              method: 'POST',
              body: { duration: spend },
            });
          }
          const stats = await request<Record<string, any>>(`projects/${id}/issues/${iid}/time_stats`, { conn });
          logWrite(ctx, path, 'gitlab_issue.time', {
            target: `#${iid}`,
            title: [estimate && `estimate ${estimate}`, spend && `spent ${spend}`].filter(Boolean).join(', '),
          });
          return { issue: iid, time: stats };
        }

        case 'subscribe': {
          const on = args.subscribed !== false;
          await request(`projects/${id}/issues/${iid}/${on ? 'subscribe' : 'unsubscribe'}`, {
            conn,
            method: 'POST',
          });
          return { issue: iid, subscribed: on };
        }

        default:
          return unknownAction(action, ISSUE_ACTIONS);
      }
    });
  },
};

const MR_ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'diff',
  'commits',
  'discussions',
  'comment',
  'reply',
  'resolve',
  'approve',
  'unapprove',
  'rebase',
  'merge',
  'close',
];

/**
 * `gitlab_mr` — propose, review and land changes.
 *
 * The operator asked for full write, merge included, and this tool has it. The brake is not in the
 * code: it is the bot account's own GitLab permissions, which is the right place for it — a project
 * the fleet may propose to but not land on is expressed by giving the account Developer instead of
 * Maintainer *there*, per project, by the person who owns that project. A hard-coded refusal here
 * would apply that judgement uniformly to repositories it has never seen.
 *
 * What *is* refused here is reviewing blind: `get` returns the review threads, who has approved and
 * what the merge request closes, and commenting, approving or merging without having read it comes
 * back as an error naming the call to make first (§14).
 */
export const gitlabMr: Tool = {
  name: 'gitlab_mr',
  parallelSafe: readOnly('list', 'get', 'diff', 'commits', 'discussions'),
  description:
    'Work with GitLab merge requests. `list` (optional `project`, `state`, `author`, `reviewer`) → ' +
    'MRs, open by default, across every project when no `project` is given. `get` (`iid`) → **the ' +
    'whole thing**: merge status, head pipeline, every comment and review thread oldest-first, who ' +
    'has approved, and the issues it closes. `create` (`source_branch`, `title`, optional ' +
    '`target_branch`, `description`, `reviewer`, `draft`). `diff` (`iid`) → the change itself. ' +
    '`commits` (`iid`). `discussions` (`iid`) → the threads alone. `comment` (`iid`, `body`, ' +
    'optional `path`+`line` to anchor to code) → a new thread. `reply` (`thread_id`, `body`). ' +
    '`resolve` (`thread_id`, optional `resolved:false`). `approve` / `unapprove`. `rebase`. ' +
    '`merge` (optional `squash`, `when_pipeline_succeeds`). `close`. **You must `get` (or `diff`) a ' +
    'merge request before you may comment on, approve, merge or close it.**',
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
      body: { type: 'string', description: '`comment`/`reply`: the text.' },
      thread_id: {
        type: 'string',
        description:
          '`reply`/`resolve`: which review thread — the `thread_id` on that entry of `get`\'s ' +
          'timeline, or `discussions`\' `id`.',
      },
      resolved: { type: 'boolean', description: '`resolve`: false re-opens the thread (default true).' },
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
        const scopeRef = hasProject ? await project(args, ctx) : null;
        const conn = scopeRef?.conn ?? (await agentConnection(ctx));
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

      const { conn, id, path } = await project(args, ctx);
      const needsIid = [
        'get',
        'update',
        'diff',
        'commits',
        'discussions',
        'comment',
        'reply',
        'resolve',
        'approve',
        'unapprove',
        'rebase',
        'merge',
        'close',
      ];
      if (needsIid.includes(action) && !Number.isFinite(iid)) {
        throw new GitLabError('`iid` is required — the merge request number within its project');
      }
      if (MR_READ_FIRST.has(action)) assertItemRead(ctx, path, 'merge_request', iid, action);

      switch (action) {
        case 'get': {
          const [m, story, approvals, closes] = await Promise.all([
            request<Record<string, any>>(`projects/${id}/merge_requests/${iid}`, { conn }),
            itemStory({ conn, id, kind: 'merge_requests', iid }),
            mrApprovals({ conn, id, iid }),
            request<Record<string, any>[]>(`projects/${id}/merge_requests/${iid}/closes_issues`, {
              conn,
              paginate: 20,
            }).catch(() => [] as Record<string, any>[]),
          ]);
          markItemRead(ctx, path, 'merge_request', iid);
          return {
            merge_request: slimMergeRequest(m),
            approvals,
            closes_issues: closes.map((i) => ({ iid: i.iid, title: i.title, state: i.state })),
            comments: story.comments,
            unresolved_threads: story.unresolved,
            omitted_entries: story.omitted,
            timeline: story.timeline,
          };
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
          markItemRead(ctx, path, 'merge_request', Number(created.iid));
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
          // `/diffs`, not `/changes`: the single-merge-request-changes endpoint has been deprecated
          // since GitLab 15.7 and is slated for removal in API v5. It also paginates, which the old
          // one did not — a 300-file merge request no longer arrives as one unbounded response.
          const [m, rows] = await Promise.all([
            request<Record<string, any>>(`projects/${id}/merge_requests/${iid}`, { conn }),
            request<Record<string, any>[]>(`projects/${id}/merge_requests/${iid}/diffs`, {
              conn,
              paginate: 100,
            }),
          ]);
          const patch = rows.map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff ?? ''}`).join('\n');
          const { text, truncated } = clip(patch, MAX_DIFF_CHARS);
          markItemRead(ctx, path, 'merge_request', iid);
          return {
            merge_request: slimMergeRequest(m),
            files: rows.map((d) => d.new_path),
            truncated,
            diff: text,
          };
        }

        case 'commits': {
          const rows = await request<Record<string, any>[]>(
            `projects/${id}/merge_requests/${iid}/commits`,
            { conn, paginate: 100 },
          );
          return { count: rows.length, commits: rows.map(slimCommit) };
        }

        case 'discussions': {
          const rows = await request<Record<string, any>[]>(
            `projects/${id}/merge_requests/${iid}/discussions`,
            { conn, paginate: 100 },
          );
          markItemRead(ctx, path, 'merge_request', iid);
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

        case 'comment':
        case 'reply': {
          const body = String(args.body ?? '').trim();
          if (!body) throw new GitLabError('`body` is required');
          const threadId = String(args.thread_id ?? '').trim();
          if (action === 'reply' && !threadId) {
            throw new GitLabError(
              '`thread_id` is required for `reply` — the thread you are answering, from `get`\'s ' +
                'timeline or `discussions`. Use `comment` to open a new thread instead.',
            );
          }
          const anchorPath = String(args.path ?? '').trim();
          const line = Number(args.line);
          let note: Record<string, any>;
          if (threadId) {
            // Answering *inside* the thread, which is what makes a review a conversation: a reply
            // posted as a new note appears at the bottom of the page, detached from the line it is
            // about, and the person who asked is never notified of an answer to their question.
            note = await request<Record<string, any>>(
              `projects/${id}/merge_requests/${iid}/discussions/${encodeURIComponent(threadId)}/notes`,
              { conn, method: 'POST', body: { body } },
            );
          } else if (anchorPath && Number.isFinite(line)) {
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
          logWrite(ctx, path, `gitlab_mr.${action}`, {
            target: `!${iid}`,
            title: body.split('\n')[0],
            url: `${conn.url}/${path}/-/merge_requests/${iid}`,
          });
          return {
            commented: true,
            merge_request: iid,
            anchored: !!anchorPath && !threadId,
            in_thread: threadId || null,
            note_id: note.id ?? null,
          };
        }

        case 'resolve': {
          const threadId = String(args.thread_id ?? '').trim();
          if (!threadId) throw new GitLabError('`thread_id` is required — which review thread to resolve');
          const resolved = args.resolved !== false;
          await request(
            `projects/${id}/merge_requests/${iid}/discussions/${encodeURIComponent(threadId)}`,
            { conn, method: 'PUT', body: { resolved } },
          );
          logWrite(ctx, path, 'gitlab_mr.resolve', {
            target: `!${iid}`,
            title: resolved ? 'resolved a thread' : 'reopened a thread',
            url: `${conn.url}/${path}/-/merge_requests/${iid}`,
          });
          return { merge_request: iid, thread_id: threadId, resolved };
        }

        case 'approve':
        case 'unapprove': {
          await request(`projects/${id}/merge_requests/${iid}/${action}`, { conn, method: 'POST' });
          logWrite(ctx, path, `gitlab_mr.${action}`, {
            target: `!${iid}`,
            title: action === 'approve' ? 'approved' : 'withdrew approval',
            url: `${conn.url}/${path}/-/merge_requests/${iid}`,
          });
          return { merge_request: iid, approved: action === 'approve' };
        }

        case 'rebase': {
          await request(`projects/${id}/merge_requests/${iid}/rebase`, { conn, method: 'PUT' });
          logWrite(ctx, path, 'gitlab_mr.rebase', {
            target: `!${iid}`,
            title: 'rebased onto the target branch',
            url: `${conn.url}/${path}/-/merge_requests/${iid}`,
          });
          // GitLab rebases asynchronously and reports the outcome on the merge request itself, so
          // saying "done" here would be a lie roughly as often as the rebase conflicts.
          return {
            merge_request: iid,
            rebase: 'started',
            note: 'GitLab rebases in the background — re-`get` the merge request to see whether it succeeded (`merge_status`).',
          };
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
  conn: GitLabConnection,
): Promise<number[] | undefined> {
  if (username === undefined) return undefined;
  const name = String(username ?? '').trim().replace(/^@/, '');
  if (!name || name.toLowerCase() === 'none') return [];
  const users = await request<Record<string, any>[]>('users', { conn, query: { username: name } });
  if (!users.length) throw new GitLabError(`no GitLab user called "${name}"`);
  return [users[0]!.id];
}
