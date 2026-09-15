import { Router, type Request, type Response } from 'express';
import { env } from '../../../config/env';
import { createLogger } from '../../../config/logger';
import { AgentModel } from '../../../domain/agents/agent.model';
import { isolationRepository } from '../../../domain/isolations/isolation.repository';
import { forgejo, gitEnabled, GitError } from '../../../domain/git/forgejo.client';
import { ensureGitServer } from '../../../domain/git/git-bootstrap';
import { cloneUrl, gitAccessFor } from '../../../domain/git/git-access';
import { gitIdentityService } from '../../../domain/git/git-identity.service';
import { assertRepoName, gitRepoService, type GitPermission } from '../../../domain/git/git-repo.service';

const log = createLogger('git-route');

/**
 * The Git page's surface (GIT_SERVER_PLAN.md §3): server status, agent accounts, repos, browsing,
 * access and activity. Everything goes through `gitRepoService` / `gitIdentityService`, the same code
 * the `git_repos` tool runs, so the page and the agents see one server.
 */
export const gitRouter = Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Operator-fixable git problems become their own status with a readable message; the rest is a 500. */
const handle =
  (fn: Handler) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof GitError) {
        const status = err.status >= 400 && err.status < 500 ? err.status : 502;
        res.status(status).json({ error: err.message });
        return;
      }
      log.error({ err: String(err), path: req.path }, 'git route failed');
      res.status(500).json({ error: 'internal error' });
    }
  };

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const repoParam = (req: Request): string => assertRepoName(String(req.params.repo ?? ''));

/** Always 200: the page shows why git is off or down inline instead of failing the load. */
gitRouter.get(
  '/status',
  handle(async () => {
    if (!gitEnabled()) {
      return { ok: false, enabled: false, org: env.GIT_ORG, error: 'GIT_ADMIN_PASSWORD is not set in .env.' };
    }
    try {
      const { version } = await Promise.race([
        ensureGitServer(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new GitError('The git server is still starting.')), 8_000)),
      ]);
      // The URL an agent clones from depends on its profile's network mode — the page shows all three.
      const agentUrls = Object.fromEntries(
        (['bridge', 'host', 'vpn'] as const).map((network) => {
          const access = gitAccessFor({ network });
          return [network, access.available ? access.url : null];
        }),
      );
      return { ok: true, enabled: true, org: env.GIT_ORG, version, server_url: env.GIT_SERVER_URL, agent_urls: agentUrls };
    } catch (err) {
      const healthy = await forgejo.healthy();
      return {
        ok: false,
        enabled: true,
        org: env.GIT_ORG,
        reachable: healthy,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }),
);

/** Every agent, with its git account (if any) and how its isolation profile reaches the server. */
gitRouter.get(
  '/identities',
  handle(async () => {
    const [agents, identities] = await Promise.all([
      AgentModel.find({}, { name: 1, isolation_id: 1 }).sort({ name: 1 }).lean().exec(),
      gitIdentityService.list(),
    ]);
    const byAgent = new Map(identities.map((i) => [String(i.agent_id), i]));
    const isoIds = [...new Set(agents.map((a) => a.isolation_id).filter(Boolean).map(String))];
    const isos = new Map(
      (await Promise.all(isoIds.map((id) => isolationRepository.findById(id)))).filter(Boolean).map((i) => [String(i!._id), i!]),
    );
    return agents.map((a) => {
      const identity = byAgent.get(String(a._id));
      const iso = a.isolation_id ? isos.get(String(a.isolation_id)) ?? null : null;
      const access = gitAccessFor(iso);
      return {
        agent_id: String(a._id),
        agent_name: a.name,
        username: identity?.username ?? null,
        email: identity?.email ?? null,
        provisioned_at: identity?.provisioned_at ?? null,
        network: iso?.network ?? null,
        reachable: access.available,
        url: access.available ? access.url : null,
        reason: access.available ? null : access.reason,
      };
    });
  }),
);

async function agentOr404(id: string) {
  const agent = await AgentModel.findById(id, { name: 1 }).lean().exec();
  if (!agent) throw new GitError('Agent not found.', 404);
  return { _id: agent._id, name: agent.name };
}

gitRouter.post(
  '/identities/:agentId/provision',
  handle(async (req) => {
    const identity = await gitIdentityService.ensure(await agentOr404(String(req.params.agentId)));
    return { username: identity.username, provisioned_at: identity.provisioned_at };
  }),
);

gitRouter.post(
  '/identities/:agentId/rotate',
  handle(async (req) => {
    const identity = await gitIdentityService.rotate(await agentOr404(String(req.params.agentId)));
    return { username: identity.username, provisioned_at: identity.provisioned_at };
  }),
);

gitRouter.get('/repos', handle(() => gitRepoService.list()));

gitRouter.post(
  '/repos',
  handle(async (req) => {
    const body = req.body ?? {};
    return gitRepoService.create({
      name: String(body.name ?? ''),
      description: typeof body.description === 'string' ? body.description : '',
      fleetReadable: body.fleet_readable !== false,
    });
  }),
);

gitRouter.get(
  '/repos/:repo',
  handle(async (req) => {
    const repo = await gitRepoService.get(repoParam(req));
    return { ...repo, clone_path: cloneUrl('', repo.name) };
  }),
);

gitRouter.patch(
  '/repos/:repo',
  handle((req) => gitRepoService.update(repoParam(req), { description: str(req.body?.description) ?? '' })),
);

gitRouter.delete(
  '/repos/:repo',
  handle(async (req) => {
    await gitRepoService.remove(repoParam(req));
    return { ok: true };
  }),
);

gitRouter.get(
  '/repos/:repo/tree',
  handle((req) => gitRepoService.tree(repoParam(req), str(req.query.ref), String(req.query.path ?? ''))),
);

gitRouter.get(
  '/repos/:repo/raw',
  handle((req) => gitRepoService.raw(repoParam(req), str(req.query.ref), String(req.query.path ?? ''))),
);

gitRouter.get(
  '/repos/:repo/commits',
  handle((req) =>
    gitRepoService.commits(repoParam(req), {
      ref: str(req.query.ref),
      path: str(req.query.path),
      page: Math.max(1, Number(req.query.page) || 1),
    }),
  ),
);

gitRouter.get(
  '/repos/:repo/commits/:sha',
  handle((req) => gitRepoService.commit(repoParam(req), String(req.params.sha))),
);

gitRouter.get('/repos/:repo/branches', handle((req) => gitRepoService.branches(repoParam(req))));

gitRouter.get('/repos/:repo/access', handle((req) => gitRepoService.access(repoParam(req))));

/** `{ fleet_readable?: boolean, agent_id?: string, permission?: 'none'|'read'|'write' }` */
gitRouter.put(
  '/repos/:repo/access',
  handle(async (req) => {
    const repo = repoParam(req);
    const body = req.body ?? {};
    if (typeof body.fleet_readable === 'boolean') await gitRepoService.setFleetReadable(repo, body.fleet_readable);
    if (body.agent_id !== undefined) {
      const permission = body.permission as GitPermission;
      if (!['none', 'read', 'write'].includes(permission)) throw new GitError('permission must be none, read or write.', 400);
      await gitRepoService.setAccess(repo, String(body.agent_id), permission);
    }
    return gitRepoService.access(repo);
  }),
);

gitRouter.get(
  '/activity',
  handle((req) =>
    gitRepoService.activity({
      agentId: str(req.query.agentId),
      repo: str(req.query.repo) ? assertRepoName(String(req.query.repo)) : undefined,
      page: Math.max(1, Number(req.query.page) || 1),
    }),
  ),
);
