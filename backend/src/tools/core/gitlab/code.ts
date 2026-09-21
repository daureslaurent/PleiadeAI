import { createLogger } from '../../../config/logger';
import { GitLabError, request, seg, slimCommit } from '../../../domain/gitlab/gitlab.service';
import { cloneCommand, ensureGitCredentials, credentialStatus } from '../../../domain/gitlab/gitlab-git';
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

/** How much of a diff is fed back before it is cut — a refactor's diff is unbounded. */
const MAX_DIFF_CHARS = 40_000;

const COMMIT_ACTIONS = ['create', 'list', 'get', 'diff', 'compare'];

/**
 * `gitlab_commit` — change a repository without a working copy.
 *
 * The Commits API takes a list of file *actions* and applies them as one atomic commit, which is
 * exactly right for the common case: a known edit to one or three files, by an agent that may not
 * even have an isolation container. No clone, no checkout, no push, and no way to leave a half-done
 * working tree behind if the turn dies in the middle.
 *
 * What it cannot do is run anything. An agent that needs to know whether its change compiles wants
 * `gitlab_repo({action:'clone'})` and ordinary `bash` — the prompt module (`GITLAB_PLAN.md` §3)
 * states that split, because a model handed both will otherwise pick whichever it saw last.
 */
export const gitlabCommit: Tool = {
  name: 'gitlab_commit',
  parallelSafe: readOnly('list', 'get', 'diff', 'compare'),
  description:
    'Commit to a GitLab repository through the API — no clone needed — and read its history. ' +
    '`create` applies `files` (each `{action: create|update|delete|move, path, content, previous_path}`) ' +
    'as ONE atomic commit on `branch`, with `message`; pass `start_branch` to create the branch in the ' +
    'same call. `list` → recent commits on a ref. `get` → one commit with its stats. `diff` → one ' +
    'commit\'s patch. `compare` (`from`, `to`) → the diff between two refs. ' +
    'Never commit straight to the default branch: branch, commit, then open a merge request.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', COMMIT_ACTIONS),
      project: PROJECT_PARAM,
      branch: { type: 'string', description: '`create`: the branch to commit on.' },
      start_branch: {
        type: 'string',
        description: '`create`: create `branch` off this one first (use when the branch does not exist yet).',
      },
      message: { type: 'string', description: '`create`: the commit message. First line is the title.' },
      files: {
        type: 'array',
        description:
          '`create`: the file changes, applied together. Each is {action, path, content?, previous_path?} — ' +
          '`content` is the FULL new file for create/update (not a patch); `previous_path` is required for move.',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'delete', 'move'] },
            path: { type: 'string' },
            content: { type: 'string' },
            previous_path: { type: 'string' },
          },
          required: ['action', 'path'],
        },
      },
      sha: { type: 'string', description: '`get`/`diff`: the commit SHA.' },
      ref: { type: 'string', description: '`list`: branch/tag (default: the default branch).' },
      from: { type: 'string', description: '`compare`: the base ref.' },
      to: { type: 'string', description: '`compare`: the ref to compare against it.' },
      limit: { type: 'number', description: '`list`: how many commits (default 20, max 100).' },
    },
    required: ['action', 'project'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const { conn, id, path } = await project(args, ctx);
      log.info({ agent: ctx.agentName, action, project: path }, 'gitlab_commit');

      switch (action) {
        case 'create': {
          const branch = String(args.branch ?? '').trim();
          const message = String(args.message ?? '').trim();
          const files = Array.isArray(args.files) ? args.files : [];
          if (!branch) throw new GitLabError('`branch` is required — never commit without naming the branch');
          if (!message) throw new GitLabError('`message` is required — say what the commit does');
          if (!files.length) throw new GitLabError('`files` is empty — there is nothing to commit');

          const actions = files.map((f: any, i: number) => {
            const fileAction = String(f?.action ?? '').trim();
            const filePath = String(f?.path ?? '').trim();
            if (!filePath) throw new GitLabError(`files[${i}] has no \`path\``);
            if (!['create', 'update', 'delete', 'move'].includes(fileAction)) {
              throw new GitLabError(`files[${i}].action must be create, update, delete or move`);
            }
            if ((fileAction === 'create' || fileAction === 'update') && typeof f.content !== 'string') {
              throw new GitLabError(
                `files[${i}] (${fileAction} ${filePath}) needs \`content\` — the complete new file, not a patch`,
              );
            }
            if (fileAction === 'move' && !f.previous_path) {
              throw new GitLabError(`files[${i}] (move ${filePath}) needs \`previous_path\``);
            }
            return {
              action: fileAction,
              file_path: filePath,
              previous_path: f.previous_path || undefined,
              content: typeof f.content === 'string' ? f.content : undefined,
            };
          });

          const commit = await request<Record<string, any>>(`projects/${id}/repository/commits`, {
            conn,
            method: 'POST',
            body: {
              branch,
              commit_message: message,
              start_branch: String(args.start_branch ?? '').trim() || undefined,
              // The commit is authored by the agent that made it, so `git log` and GitLab's own
              // history answer "which agent wrote this" without consulting our activity feed.
              author_name: ctx.agentName,
              actions,
            },
          });
          logWrite(ctx, path, 'gitlab_commit.create', {
            target: String(commit.id ?? '').slice(0, 8),
            title: message.split('\n')[0],
            url: commit.web_url,
          });
          return {
            commit: slimCommit(commit),
            branch,
            files: actions.length,
            next: 'Open a merge request for this branch with `gitlab_mr({action:"create"})`.',
          };
        }

        case 'list': {
          const rows = await request<Record<string, any>[]>(`projects/${id}/repository/commits`, {
            conn,
            paginate: Math.min(100, Math.max(1, Number(args.limit) || 20)),
            query: { ref_name: args.ref },
          });
          return { count: rows.length, commits: rows.map(slimCommit) };
        }

        case 'get': {
          const sha = String(args.sha ?? '').trim();
          if (!sha) throw new GitLabError('`sha` is required');
          const c = await request<Record<string, any>>(`projects/${id}/repository/commits/${seg(sha)}`, { conn });
          return { commit: slimCommit(c) };
        }

        case 'diff': {
          const sha = String(args.sha ?? '').trim();
          if (!sha) throw new GitLabError('`sha` is required');
          const rows = await request<Record<string, any>[]>(
            `projects/${id}/repository/commits/${seg(sha)}/diff`,
            { conn },
          );
          return renderDiff(rows);
        }

        case 'compare': {
          const from = String(args.from ?? '').trim();
          const to = String(args.to ?? '').trim();
          if (!from || !to) throw new GitLabError('`from` and `to` are both required');
          const cmp = await request<Record<string, any>>(`projects/${id}/repository/compare`, {
            conn,
            query: { from, to },
          });
          return {
            from,
            to,
            commits: (cmp.commits ?? []).map(slimCommit),
            ...renderDiff(cmp.diffs ?? []),
          };
        }

        default:
          return unknownAction(action, COMMIT_ACTIONS);
      }
    });
  },
};

/** Flatten GitLab's per-file diff objects into one patch, budgeted. */
function renderDiff(rows: Record<string, any>[]): Record<string, unknown> {
  const patch = rows
    .map((d) => `--- ${d.old_path}\n+++ ${d.new_path}\n${d.diff ?? ''}`)
    .join('\n');
  const { text, truncated } = clip(patch, MAX_DIFF_CHARS);
  return {
    files: rows.map((d) => ({
      path: d.new_path,
      renamed: d.renamed_file || undefined,
      deleted: d.deleted_file || undefined,
      added: d.new_file || undefined,
    })),
    truncated,
    diff: text,
  };
}

const REPO_ACTIONS = ['clone', 'status'];

/**
 * `gitlab_repo` — a real working copy, inside the agent's own container.
 *
 * The other half of the write surface. This is deliberately *not* a git wrapper: it clones, wires up
 * credentials, and gets out of the way. Everything after the clone — branch, build, test, commit,
 * push — is ordinary `bash`, because an agent that already knows git does not need us to re-expose
 * it one verb at a time, and because the useful thing (running the test suite between the edit and
 * the push) was never a git command in the first place.
 *
 * Credentials are installed as files inside the container, once (`gitlab-git.ts`): `~/.git-credentials`
 * for HTTPS, `~/.ssh/gitlab_ed25519` for SSH. Never an argv, never an env var — an agent that can run
 * `bash` can read its own environment and `ps`, and a token that reaches a tool result reaches the
 * model's context, the transcript, and the training pool after it.
 *
 * Isolation-only, and strict about it: with no container there is nowhere to clone *to*, and the
 * standing rule (`CLAUDE.md`) is that an isolated tool surfaces the error rather than quietly
 * running on the backend.
 */
export const gitlabRepo: Tool = {
  name: 'gitlab_repo',
  description:
    'Clone a GitLab project into your own container so you can build, test and run it. ' +
    '`clone` (`project`, optional `branch`, `path`) → checks out the repo and returns the directory; ' +
    'credentials are installed for you, so plain `bash` git works afterwards — `git checkout -b`, ' +
    '`git commit`, `git push` all authenticate with no further setup. `status` → whether credentials ' +
    'are installed and where things are checked out. Use this when the job needs the code to RUN; for ' +
    'a small certain edit, `gitlab_commit` is one call and needs no container.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', REPO_ACTIONS),
      project: PROJECT_PARAM,
      branch: { type: 'string', description: '`clone`: branch to check out (default: the default branch).' },
      path: { type: 'string', description: '`clone`: where to put it (default: ~/repos/<project name>).' },
      depth: { type: 'number', description: '`clone`: shallow-clone depth. 0 → full history (default 1).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      if (ctx.isolationError) throw new GitLabError(`this agent's container is not ready: ${ctx.isolationError}`);
      if (!ctx.exec) {
        throw new GitLabError(
          'cloning needs an isolation container and this agent has none — assign an isolation profile on ' +
            'the Agents page, or make the change with `gitlab_commit` instead (no container required).',
        );
      }

      switch (action) {
        case 'status':
          return credentialStatus(ctx.exec);

        case 'clone': {
          const { conn, id, path } = await project(args, ctx);
          // Resolve the project first: it validates the group scope, confirms the bot can see the
          // repo, and gives us the default branch — three failures that are far cheaper here than as
          // a git exit code the agent has to interpret.
          const p = await request<Record<string, any>>(`projects/${id}`, { conn });
          const branch = String(args.branch ?? '').trim() || p.default_branch;
          const target = String(args.path ?? '').trim() || `~/repos/${p.path}`;
          const depth = Number(args.depth);

          const installed = await ensureGitCredentials(ctx.exec, conn, ctx.agentName);
          const { command, dir } = cloneCommand(p.path_with_namespace, {
            branch,
            target,
            depth: Number.isFinite(depth) ? depth : 1,
            ...installed,
          });
          log.info({ agent: ctx.agentName, project: p.path_with_namespace, dir }, 'gitlab clone');
          const res = await ctx.exec.run(command, { timeoutMs: 300_000, onOutput: ctx.emitOutput });
          if (res.exitCode !== 0) {
            throw new GitLabError(
              `clone failed (exit ${res.exitCode}): ${`${res.stdout}\n${res.stderr}`.trim().slice(-1500)}`,
            );
          }
          logWrite(ctx, path, 'gitlab_repo.clone', { target: branch, title: `cloned into ${dir}`, url: p.web_url });
          return {
            project: p.path_with_namespace,
            branch,
            dir,
            next:
              `The working copy is at ${dir} and git is authenticated there. Use \`bash\` from here: ` +
              '`git checkout -b …`, edit, run the tests, `git commit`, `git push -u origin <branch>`, ' +
              'then open the merge request with `gitlab_mr({action:"create"})`.',
          };
        }

        default:
          return unknownAction(action, REPO_ACTIONS);
      }
    });
  },
};
