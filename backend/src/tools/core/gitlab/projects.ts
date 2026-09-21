import { createLogger } from '../../../config/logger';
import {
  GitLabError,
  connection,
  request,
  scopedPath,
  seg,
  slimCommit,
  slimProject,
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

/** How much of one file is fed back into context before it is cut. */
const MAX_FILE_CHARS = 60_000;

const PROJECT_ACTIONS = ['list', 'get', 'branches', 'create_branch', 'delete_branch'];

/**
 * `gitlab_projects` — what exists, and the branches in it.
 *
 * The entry point: an agent that has been told "fix the login bug" has a sentence, not a repository,
 * and this is where a sentence becomes a project path it can pass to the other eight tools.
 */
export const gitlabProjects: Tool = {
  name: 'gitlab_projects',
  parallelSafe: readOnly('list', 'get', 'branches'),
  description:
    'Browse the GitLab projects this instance can reach, and manage their branches. ' +
    '`list` (optional `search`) → the projects, newest activity first. `get` → one project in full: ' +
    'default branch, visibility, topics, open issue count. `branches` → its branches with their last ' +
    'commit. `create_branch` (`branch`, `from` — defaults to the default branch) and `delete_branch`. ' +
    'Start here when you have been given a task but not a repository.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', PROJECT_ACTIONS),
      project: PROJECT_PARAM,
      search: { type: 'string', description: '`list`: filter projects by name/path.' },
      branch: { type: 'string', description: 'The branch to create or delete.' },
      from: { type: 'string', description: '`create_branch`: what to branch off (default: the default branch).' },
      limit: { type: 'number', description: 'How many rows to return (default 30, max 100).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      log.info({ agent: ctx.agentName, action, project: args.project }, 'gitlab_projects');

      switch (action) {
        case 'list': {
          // The only action that takes no project — `scopedPath` decides whether it runs against
          // the confined group's subtree or the instance root.
          const conn = await connection();
          const rows = await request<Record<string, any>[]>(
            scopedPath(conn, 'projects', 'projects'),
            {
              conn,
              paginate: limit,
              query: {
                search: args.search,
                order_by: 'last_activity_at',
                membership: conn.group ? undefined : true,
                include_subgroups: conn.group ? true : undefined,
                archived: false,
              },
            },
          );
          return { count: rows.length, projects: rows.map(slimProject) };
        }

        case 'get': {
          const { conn, id } = await project(args);
          const p = await request<Record<string, any>>(`projects/${id}`, { conn });
          return { project: slimProject(p) };
        }

        case 'branches': {
          const { conn, id } = await project(args);
          const rows = await request<Record<string, any>[]>(`projects/${id}/repository/branches`, {
            conn,
            paginate: limit,
          });
          return {
            count: rows.length,
            branches: rows.map((b) => ({
              name: b.name,
              default: b.default,
              protected: b.protected,
              last_commit: b.commit ? slimCommit(b.commit) : null,
            })),
          };
        }

        case 'create_branch': {
          const { conn, id, path } = await project(args);
          const branch = String(args.branch ?? '').trim();
          if (!branch) throw new GitLabError('`branch` is required — the name of the branch to create');
          let ref = String(args.from ?? '').trim();
          if (!ref) {
            const p = await request<Record<string, any>>(`projects/${id}`, { conn });
            ref = p.default_branch;
          }
          const created = await request<Record<string, any>>(`projects/${id}/repository/branches`, {
            conn,
            method: 'POST',
            query: { branch, ref },
          });
          logWrite(ctx, path, 'gitlab_projects.create_branch', {
            target: branch,
            title: `branched ${branch} from ${ref}`,
            url: created.web_url,
          });
          return { branch: created.name, from: ref, url: created.web_url };
        }

        case 'delete_branch': {
          const { conn, id, path } = await project(args);
          const branch = String(args.branch ?? '').trim();
          if (!branch) throw new GitLabError('`branch` is required');
          await request(`projects/${id}/repository/branches/${seg(branch)}`, { conn, method: 'DELETE' });
          logWrite(ctx, path, 'gitlab_projects.delete_branch', { target: branch, title: `deleted ${branch}` });
          return { deleted: branch };
        }

        default:
          return unknownAction(action, PROJECT_ACTIONS);
      }
    });
  },
};

const FILE_ACTIONS = ['tree', 'read', 'history'];

/**
 * `gitlab_files` — read a repository without cloning it.
 *
 * The cheap half of the code surface. Reading three files to answer a question costs three API calls
 * and no container; the moment the job needs a build or a test run, `gitlab_repo({action:'clone'})`
 * is the right tool instead, and the prompt module draws exactly that line.
 */
export const gitlabFiles: Tool = {
  name: 'gitlab_files',
  parallelSafe: true,
  description:
    'Read files and directories straight from a GitLab repository, at any branch, tag or commit. ' +
    '`tree` (optional `path`, `recursive`) → what is in a directory. `read` (`path`) → one file\'s ' +
    'contents. `history` (`path`) → the commits that touched it. All take an optional `ref` ' +
    '(branch/tag/SHA, default: the default branch). Long files are cut with a marker. For anything ' +
    'you need to build, run or test, clone with `gitlab_repo` instead.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to read.', FILE_ACTIONS),
      project: PROJECT_PARAM,
      path: { type: 'string', description: 'File path for `read`/`history`, directory for `tree` (default: root).' },
      ref: { type: 'string', description: 'Branch, tag or commit SHA (default: the default branch).' },
      recursive: { type: 'boolean', description: '`tree`: descend into subdirectories.' },
      limit: { type: 'number', description: 'How many entries/commits (default 100, max 300).' },
    },
    required: ['action', 'project'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const { conn, id } = await project(args);
      const ref = String(args.ref ?? '').trim() || undefined;
      const limit = Math.min(300, Math.max(1, Number(args.limit) || 100));
      log.info({ agent: ctx.agentName, action, project: args.project, path: args.path }, 'gitlab_files');

      switch (action) {
        case 'tree': {
          const rows = await request<Record<string, any>[]>(`projects/${id}/repository/tree`, {
            conn,
            paginate: limit,
            query: { path: args.path, ref, recursive: args.recursive ? true : undefined },
          });
          return {
            ref: ref ?? 'default',
            count: rows.length,
            entries: rows.map((e) => ({ path: e.path, name: e.name, type: e.type })),
          };
        }

        case 'read': {
          const path = String(args.path ?? '').trim();
          if (!path) throw new GitLabError('`path` is required — the file to read');
          // The `/raw` endpoint returns bytes rather than a base64 envelope: one decode step fewer,
          // and no chance of silently handing the model a base64 blob when a file isn't UTF-8.
          const body = await request<string>(
            `projects/${id}/repository/files/${seg(path)}/raw`,
            { conn, raw: true, query: { ref } },
          );
          const { text, truncated } = clip(body, MAX_FILE_CHARS);
          return { path, ref: ref ?? 'default', truncated, content: text };
        }

        case 'history': {
          const rows = await request<Record<string, any>[]>(`projects/${id}/repository/commits`, {
            conn,
            paginate: Math.min(limit, 50),
            query: { path: args.path, ref_name: ref },
          });
          return { path: args.path ?? '', count: rows.length, commits: rows.map(slimCommit) };
        }

        default:
          return unknownAction(action, FILE_ACTIONS);
      }
    });
  },
};
