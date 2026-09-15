import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { AgentModel } from '../agents/agent.model';
import { ensureGitServer } from './git-bootstrap';
import { forgejo, GitError, seg } from './forgejo.client';
import { agentNamesById, gitIdentityService } from './git-identity.service';

const log = createLogger('git-repo');

// ---- Wire shapes (Forgejo's, trimmed to what we read) ----------------------------------------------

interface FjUser {
  login: string;
}
interface FjRepo {
  name: string;
  description: string;
  private: boolean;
  empty: boolean;
  size: number;
  default_branch: string;
  created_at: string;
  updated_at: string;
  owner: FjUser;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}
interface FjContent {
  name: string;
  path: string;
  type: string;
  size: number;
  last_commit_sha?: string;
  last_commit_when?: string;
}
interface FjCommitUser {
  name: string;
  email: string;
  date: string;
}
interface FjCommit {
  sha: string;
  commit: { message: string; author: FjCommitUser; committer: FjCommitUser };
  parents?: Array<{ sha: string }>;
  files?: Array<{ filename: string; status: string }>;
  stats?: { total: number; additions: number; deletions: number };
}
interface FjBranch {
  name: string;
  protected: boolean;
  commit: { id: string; message: string; timestamp: string; author: { name: string; email: string } };
}
interface FjActivity {
  id: number;
  op_type: string;
  act_user: FjUser;
  repo?: { name: string } | null;
  ref_name: string;
  content: string;
  created: string;
}

// ---- Public shapes ---------------------------------------------------------------------------------

export type GitPermission = 'none' | 'read' | 'write';

export interface GitAgentRef {
  agent_id: string | null;
  agent_name: string | null;
  username: string;
}

export interface GitRepo {
  name: string;
  description: string;
  empty: boolean;
  size_kb: number;
  default_branch: string;
  created_at: string;
  updated_at: string;
  fleet_readable: boolean;
}

export interface GitCommitSummary {
  sha: string;
  message: string;
  author_name: string;
  author_email: string;
  date: string;
  agent: GitAgentRef | null;
}

export interface GitActivity {
  id: number;
  op: string;
  actor: GitAgentRef;
  repo: string | null;
  ref: string;
  created: string;
  commits: Array<{ sha: string; message: string }>;
  commit_count: number;
}

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const RAW_MAX_BYTES = 512 * 1024;
const DIFF_MAX_CHARS = 1_000_000;

const repoPath = (repo: string) => `/repos/${seg(env.GIT_ORG)}/${seg(repo)}`;

export function assertRepoName(name: string): string {
  const n = name.trim().replace(/\.git$/, '');
  if (!REPO_NAME.test(n) || n === '.' || n === '..') {
    throw new GitError('A repo name is 1–100 characters of letters, digits, ".", "_" or "-".', 400);
  }
  return n;
}

/** Map git usernames and commit emails back to agents, loaded once per request. */
async function identityIndex(): Promise<{ byUsername: Map<string, GitAgentRef>; byEmail: Map<string, GitAgentRef> }> {
  const identities = await gitIdentityService.list();
  const names = await agentNamesById(identities.map((i) => i.agent_id));
  const byUsername = new Map<string, GitAgentRef>();
  const byEmail = new Map<string, GitAgentRef>();
  for (const i of identities) {
    const ref = { agent_id: String(i.agent_id), agent_name: names.get(String(i.agent_id)) ?? null, username: i.username };
    byUsername.set(i.username, ref);
    byEmail.set(i.email.toLowerCase(), ref);
  }
  return { byUsername, byEmail };
}

/** Walk a paginated list endpoint to the end (bounded — a fleet has tens of repos, not thousands). */
async function all<T>(path: string, query: Record<string, string | number | boolean> = {}, sudo?: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const { items, hasMore } = await forgejo.page<T[]>(path, { query: { ...query, page, limit: 50 }, sudo });
    out.push(...items);
    if (!hasMore || items.length === 0) break;
  }
  return out;
}

/**
 * Repos, browsing, access and activity on the internal git server (GIT_SERVER_PLAN.md §2). Every repo
 * lives in the one org; creation always goes through the admin client, so an agent's token never
 * needs org rights. Read access for the fleet is membership of the repo in the `fleet` team; write is
 * an explicit collaborator grant.
 */
export const gitRepoService = {
  async list(): Promise<GitRepo[]> {
    const { teamId } = await ensureGitServer();
    const [repos, teamRepos] = await Promise.all([
      all<FjRepo>(`/orgs/${seg(env.GIT_ORG)}/repos`),
      all<FjRepo>(`/teams/${teamId}/repos`),
    ]);
    const fleet = new Set(teamRepos.map((r) => r.name));
    return repos
      .map((r) => ({
        name: r.name,
        description: r.description,
        empty: r.empty,
        size_kb: r.size,
        default_branch: r.default_branch,
        created_at: r.created_at,
        updated_at: r.updated_at,
        fleet_readable: fleet.has(r.name),
      }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },

  async get(repo: string): Promise<GitRepo> {
    const { teamId } = await ensureGitServer();
    const r = await forgejo.json<FjRepo>(repoPath(repo));
    const inTeam = await forgejo.request(`/teams/${teamId}/repos/${seg(env.GIT_ORG)}/${seg(repo)}`, { okStatuses: [404] });
    return {
      name: r.name,
      description: r.description,
      empty: r.empty,
      size_kb: r.size,
      default_branch: r.default_branch,
      created_at: r.created_at,
      updated_at: r.updated_at,
      fleet_readable: inTeam.ok,
    };
  },

  /** Create a repo in the org, fleet-readable, with an initial README so it can be browsed and cloned at once. */
  async create(input: { name: string; description?: string; creatorAgentId?: string; fleetReadable?: boolean }): Promise<GitRepo> {
    const { teamId } = await ensureGitServer();
    const name = assertRepoName(input.name);
    const exists = await forgejo.request(repoPath(name), { okStatuses: [404] });
    if (exists.ok) throw new GitError(`A repo named "${name}" already exists.`, 409);

    await forgejo.json(`/orgs/${seg(env.GIT_ORG)}/repos`, {
      method: 'POST',
      body: {
        name,
        description: (input.description ?? '').slice(0, 2000),
        private: true,
        auto_init: true,
        default_branch: 'main',
        readme: 'Default',
      },
    });
    if (input.fleetReadable !== false) {
      await forgejo.request(`/teams/${teamId}/repos/${seg(env.GIT_ORG)}/${seg(name)}`, { method: 'PUT' });
    }
    if (input.creatorAgentId) await this.setAccess(name, input.creatorAgentId, 'write');
    log.info({ repo: name, creator: input.creatorAgentId ?? 'operator' }, 'created git repo');
    return this.get(name);
  },

  async update(repo: string, patch: { description?: string }): Promise<GitRepo> {
    await ensureGitServer();
    if (patch.description !== undefined) {
      await forgejo.json(repoPath(repo), { method: 'PATCH', body: { description: patch.description.slice(0, 2000) } });
    }
    return this.get(repo);
  },

  async remove(repo: string): Promise<void> {
    await ensureGitServer();
    await forgejo.request(repoPath(repo), { method: 'DELETE' });
    log.info({ repo }, 'deleted git repo');
  },

  async setFleetReadable(repo: string, on: boolean): Promise<void> {
    const { teamId } = await ensureGitServer();
    await forgejo.request(`/teams/${teamId}/repos/${seg(env.GIT_ORG)}/${seg(repo)}`, {
      method: on ? 'PUT' : 'DELETE',
      okStatuses: [404],
    });
  },

  /** Explicit per-agent grant. `read` matters only on a repo that is not fleet-readable. */
  async setAccess(repo: string, agentId: string, permission: GitPermission): Promise<void> {
    await ensureGitServer();
    const agent = await AgentModel.findById(agentId, { name: 1 }).lean().exec();
    if (!agent) throw new GitError('Agent not found.', 404);
    const identity = await gitIdentityService.ensure({ _id: agent._id, name: agent.name });
    const path = `${repoPath(repo)}/collaborators/${seg(identity.username)}`;
    if (permission === 'none') {
      await forgejo.request(path, { method: 'DELETE', okStatuses: [404] });
    } else {
      await forgejo.request(path, { method: 'PUT', body: { permission } });
    }
  },

  /** Every agent with a git account, and what it can do on this repo. */
  async access(repo: string): Promise<{
    fleet_readable: boolean;
    agents: Array<GitAgentRef & { permission: GitPermission; explicit: boolean }>;
  }> {
    const meta = await this.get(repo);
    const collaborators = await all<FjUser>(`${repoPath(repo)}/collaborators`);
    const explicit = new Map<string, GitPermission>();
    await Promise.all(
      collaborators.map(async (c) => {
        const p = await forgejo.json<{ permission: string }>(`${repoPath(repo)}/collaborators/${seg(c.login)}/permission`);
        explicit.set(c.login, p.permission === 'read' ? 'read' : 'write');
      }),
    );
    const { byUsername } = await identityIndex();
    const agents = [...byUsername.values()].map((ref) => {
      const grant = explicit.get(ref.username);
      return {
        ...ref,
        permission: grant ?? (meta.fleet_readable ? ('read' as const) : ('none' as const)),
        explicit: !!grant,
      };
    });
    agents.sort((a, b) => (a.agent_name ?? a.username).localeCompare(b.agent_name ?? b.username));
    return { fleet_readable: meta.fleet_readable, agents };
  },

  /** The repos an agent's account can reach, seen through its own eyes (admin `Sudo`). */
  async listForAgent(username: string, timeoutMs?: number): Promise<Array<{ name: string; description: string; permission: GitPermission; updated_at: string }>> {
    const { items } = await forgejo.page<FjRepo[]>('/user/repos', { sudo: username, query: { limit: 50 }, timeoutMs });
    return items
      .filter((r) => r.owner.login === env.GIT_ORG)
      .map((r) => ({
        name: r.name,
        description: r.description,
        permission: (r.permissions?.push ? 'write' : 'read') as GitPermission,
        updated_at: r.updated_at,
      }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },

  // ---- Browsing ------------------------------------------------------------------------------------

  async tree(repo: string, ref: string | undefined, path: string): Promise<Array<{ name: string; path: string; type: string; size: number }>> {
    await ensureGitServer();
    const clean = path.replace(/^\/+|\/+$/g, '');
    const res = await forgejo.request(`${repoPath(repo)}/contents${clean ? `/${clean.split('/').map(seg).join('/')}` : ''}`, {
      query: { ref },
      okStatuses: [404],
    });
    if (res.status === 404) {
      if (!clean) {
        await forgejo.request(repoPath(repo)); // a missing repo throws its own 404; an empty one has no root
        return [];
      }
      throw new GitError(`No such path "${clean}" at ${ref || 'the default branch'}.`, 404);
    }
    const body = (await res.json()) as FjContent[] | FjContent;
    const entries = Array.isArray(body) ? body : [body];
    return entries
      .map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }))
      .sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
  },

  async raw(repo: string, ref: string | undefined, path: string): Promise<{ path: string; size: number; binary: boolean; truncated: boolean; content: string }> {
    await ensureGitServer();
    const clean = path.replace(/^\/+/, '');
    if (!clean) throw new GitError('A file path is required.', 400);
    const res = await forgejo.request(`${repoPath(repo)}/raw/${clean.split('/').map(seg).join('/')}`, { query: { ref } });
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 8000);
    const binary = head.includes(0);
    const truncated = buf.length > RAW_MAX_BYTES;
    return {
      path: clean,
      size: buf.length,
      binary,
      truncated,
      content: binary ? '' : buf.subarray(0, RAW_MAX_BYTES).toString('utf8'),
    };
  },

  async commits(repo: string, opts: { ref?: string; path?: string; page?: number; limit?: number }): Promise<{ items: GitCommitSummary[]; hasMore: boolean }> {
    await ensureGitServer();
    const res = await forgejo.request(`${repoPath(repo)}/commits`, {
      query: {
        sha: opts.ref,
        path: opts.path,
        page: opts.page ?? 1,
        limit: Math.min(opts.limit ?? 30, 50),
        stat: false,
        files: false,
        verification: false,
      },
      okStatuses: [409], // "Git Repository is empty"
    });
    if (res.status === 409) return { items: [], hasMore: false };
    const list = (await res.json()) as FjCommit[];
    const { byEmail } = await identityIndex();
    return {
      items: list.map((c) => ({
        sha: c.sha,
        message: c.commit.message,
        author_name: c.commit.author.name,
        author_email: c.commit.author.email,
        date: c.commit.author.date,
        agent: byEmail.get(c.commit.author.email.toLowerCase()) ?? null,
      })),
      hasMore: res.headers.get('x-hasmore') === 'true',
    };
  },

  async commit(repo: string, sha: string): Promise<GitCommitSummary & {
    parents: string[];
    files: Array<{ filename: string; status: string }>;
    stats: { total: number; additions: number; deletions: number } | null;
    diff: string;
    diff_truncated: boolean;
  }> {
    await ensureGitServer();
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new GitError('Not a commit sha.', 400);
    const [c, diff] = await Promise.all([
      forgejo.json<FjCommit>(`${repoPath(repo)}/git/commits/${sha}`, { query: { stat: true, files: true, verification: false } }),
      forgejo.text(`${repoPath(repo)}/git/commits/${sha}.diff`, { timeoutMs: 20_000 }),
    ]);
    const { byEmail } = await identityIndex();
    return {
      sha: c.sha,
      message: c.commit.message,
      author_name: c.commit.author.name,
      author_email: c.commit.author.email,
      date: c.commit.author.date,
      agent: byEmail.get(c.commit.author.email.toLowerCase()) ?? null,
      parents: (c.parents ?? []).map((p) => p.sha),
      files: c.files ?? [],
      stats: c.stats ?? null,
      diff: diff.slice(0, DIFF_MAX_CHARS),
      diff_truncated: diff.length > DIFF_MAX_CHARS,
    };
  },

  async branches(repo: string): Promise<Array<{ name: string; sha: string; message: string; date: string; author_name: string; protected: boolean }>> {
    await ensureGitServer();
    const list = await all<FjBranch>(`${repoPath(repo)}/branches`);
    return list
      .map((b) => ({
        name: b.name,
        sha: b.commit.id,
        message: b.commit.message,
        date: b.commit.timestamp,
        author_name: b.commit.author?.name ?? '',
        protected: b.protected,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  },

  // ---- Activity ------------------------------------------------------------------------------------

  /**
   * Pushes, repo creations, branch and tag events. Narrowed by agent (that account's own feed) and/or
   * by repo (the repo's feed); both together read the agent's feed and keep that repo's events.
   */
  async activity(opts: { agentId?: string; repo?: string; page?: number }): Promise<{ items: GitActivity[]; hasMore: boolean }> {
    await ensureGitServer();
    const limit = 30;
    const page = opts.page ?? 1;
    let path = `/orgs/${seg(env.GIT_ORG)}/activities/feeds`;
    const query: Record<string, string | number | boolean> = { page, limit };
    if (opts.agentId) {
      const identity = await gitIdentityService.findByAgent(opts.agentId);
      if (!identity) return { items: [], hasMore: false };
      path = `/users/${seg(identity.username)}/activities/feeds`;
      query['only-performed-by'] = true;
    } else if (opts.repo) {
      path = `${repoPath(opts.repo)}/activities/feeds`;
    }
    const { items, hasMore } = await forgejo.page<FjActivity[]>(path, { query });
    const { byUsername } = await identityIndex();
    const mapped = items
      .filter((a) => !opts.repo || a.repo?.name === opts.repo)
      .map((a) => {
        let commits: Array<{ sha: string; message: string }> = [];
        let count = 0;
        if (a.content && (a.op_type === 'commit_repo' || a.op_type === 'mirror_sync_push')) {
          try {
            const parsed = JSON.parse(a.content) as { Commits?: Array<{ Sha1: string; Message: string }>; Len?: number };
            commits = (parsed.Commits ?? []).slice(0, 10).map((c) => ({ sha: c.Sha1, message: c.Message }));
            count = parsed.Len ?? commits.length;
          } catch {
            /* content is free text for some ops */
          }
        }
        return {
          id: a.id,
          op: a.op_type,
          actor: byUsername.get(a.act_user.login) ?? { agent_id: null, agent_name: null, username: a.act_user.login },
          repo: a.repo?.name ?? null,
          ref: a.ref_name.replace(/^refs\/(heads|tags)\//, ''),
          created: a.created,
          commits,
          commit_count: count,
        };
      });
    return { items: mapped, hasMore };
  },
};
