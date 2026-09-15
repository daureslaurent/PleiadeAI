import { agentRepository } from '../../domain/agents/agent.repository';
import { isolationRepository } from '../../domain/isolations/isolation.repository';
import { GitError } from '../../domain/git/forgejo.client';
import { cloneUrl, gitAccessFor } from '../../domain/git/git-access';
import { gitIdentityService } from '../../domain/git/git-identity.service';
import { gitRepoService } from '../../domain/git/git-repo.service';
import type { Tool } from '../types';

/**
 * The fleet's internal git server, seen from the agent (GIT_SERVER_PLAN.md §4). Only the catalogue
 * and repo creation live here — cloning, committing and pushing are ordinary `git` in `bash`, with the
 * agent's own credentials already planted in its container. Creation goes through the backend's admin
 * client, so the agent's token never needs org rights.
 */
export const gitRepos: Tool = {
  name: 'git_repos',
  description:
    'The fleet\'s internal git server. `list` shows the repos you can reach with their clone URL and your ' +
    'permission; `info` shows a repo\'s branches and recent commits; `create` makes a new repo (you get ' +
    'write access, the rest of the fleet can read it). Clone, commit and push with `git` in bash — your ' +
    'credentials are already configured.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'info', 'create'] },
      repo: { type: 'string', description: 'Repo name (for info and create): letters, digits, ".", "_" or "-".' },
      ref: { type: 'string', description: 'Branch or commit for info (default: the default branch).' },
      description: { type: 'string', description: 'One line saying what the repo holds (for create).' },
    },
    required: ['action'],
  },
  parallelSafe: (args) => args.action !== 'create',

  async execute(args, ctx) {
    if (ctx.isolationError) return { result: { ok: false, error: ctx.isolationError } };

    const agent = await agentRepository.findById(ctx.agentId);
    if (!agent) return { result: { ok: false, error: 'agent not found' } };
    const iso = agent.isolation_id ? await isolationRepository.findById(agent.isolation_id) : null;
    const access = gitAccessFor(iso);
    if (!access.available) return { result: { ok: false, error: `Git is unavailable: ${access.reason}.` } };

    const action = String(args.action ?? '');
    try {
      const identity = await gitIdentityService.ensure(agent);

      if (action === 'list') {
        const repos = await gitRepoService.listForAgent(identity.username);
        return {
          result: {
            ok: true,
            you: identity.username,
            server: access.url,
            repos: repos.map((r) => ({
              name: r.name,
              description: r.description,
              permission: r.permission,
              clone: cloneUrl(access.url, r.name),
              updated_at: r.updated_at,
            })),
          },
        };
      }

      const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
      if (!repo) return { result: { ok: false, error: '`repo` is required for this action.' } };

      if (action === 'info') {
        const reachable = await gitRepoService.listForAgent(identity.username);
        const mine = reachable.find((r) => r.name === repo);
        if (!mine) return { result: { ok: false, error: `No repo "${repo}" that you can read. Use action "list".` } };
        const [meta, branches, commits] = await Promise.all([
          gitRepoService.get(repo),
          gitRepoService.branches(repo),
          gitRepoService.commits(repo, { ref: typeof args.ref === 'string' ? args.ref : undefined, limit: 10 }),
        ]);
        return {
          result: {
            ok: true,
            repo: meta.name,
            description: meta.description,
            permission: mine.permission,
            clone: cloneUrl(access.url, meta.name),
            default_branch: meta.default_branch,
            branches: branches.slice(0, 20).map((b) => ({ name: b.name, sha: b.sha.slice(0, 10), updated: b.date })),
            recent_commits: commits.items.map((c) => ({
              sha: c.sha.slice(0, 10),
              message: c.message.split('\n')[0],
              author: c.agent?.agent_name ?? c.author_name,
              date: c.date,
            })),
          },
        };
      }

      if (action === 'create') {
        const created = await gitRepoService.create({
          name: repo,
          description: typeof args.description === 'string' ? args.description : '',
          creatorAgentId: ctx.agentId,
        });
        return {
          result: {
            ok: true,
            repo: created.name,
            permission: 'write',
            clone: cloneUrl(access.url, created.name),
            default_branch: created.default_branch,
            note: 'Created with an initial README commit on main. Clone it into /workspace, then commit and push.',
          },
        };
      }

      return { result: { ok: false, error: `Unknown action "${action}". Use list, info or create.` } };
    } catch (err) {
      const message = err instanceof GitError ? err.message : String(err);
      return { result: { ok: false, error: message } };
    }
  },
};
