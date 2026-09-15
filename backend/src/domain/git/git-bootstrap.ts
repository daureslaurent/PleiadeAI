import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { dockerService } from '../../isolation/docker.service';
import { forgejo, gitEnabled, GitError, seg } from './forgejo.client';

const log = createLogger('git-bootstrap');

/** The fleet's read-everything team. Repos are added to it one by one, so read access is per repo. */
export const FLEET_TEAM = 'fleet';
const TEAM_UNITS = ['repo.code', 'repo.issues', 'repo.pulls', 'repo.releases', 'repo.wiki'];

export interface GitServerInfo {
  version: string;
  teamId: number;
}

let ready: Promise<GitServerInfo> | null = null;

/**
 * Make the server usable (GIT_SERVER_PLAN.md §2): the admin account the backend drives it with, the
 * org every repo lives in, and the fleet team. Idempotent and memoised; a failure clears the memo so
 * the next caller (a turn, a page load) tries again instead of inheriting a stale error.
 *
 * The admin is created through the container's own CLI because the API has no anonymous way to make
 * the first account. The password travels on stdin, never in argv (which `ps` on the host would show).
 */
export function ensureGitServer(): Promise<GitServerInfo> {
  if (!gitEnabled()) return Promise.reject(new GitError('The internal git server is not configured.'));
  if (!ready) {
    ready = bootstrap().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function bootstrap(): Promise<GitServerInfo> {
  await waitHealthy(120_000);
  await ensureAdmin();

  const org = await forgejo.request(`/orgs/${seg(env.GIT_ORG)}`, { okStatuses: [404] });
  if (org.status === 404) {
    await forgejo.json('/orgs', {
      method: 'POST',
      body: { username: env.GIT_ORG, full_name: 'Pleiades fleet', visibility: 'private' },
    });
    log.info({ org: env.GIT_ORG }, 'created git organisation');
  }

  const teams = await forgejo.json<Array<{ id: number; name: string }>>(`/orgs/${seg(env.GIT_ORG)}/teams`);
  let team = teams.find((t) => t.name === FLEET_TEAM);
  if (!team) {
    team = await forgejo.json<{ id: number; name: string }>(`/orgs/${seg(env.GIT_ORG)}/teams`, {
      method: 'POST',
      body: {
        name: FLEET_TEAM,
        description: 'Every agent. Read access to the repos marked fleet-readable.',
        permission: 'read',
        includes_all_repositories: false,
        can_create_org_repo: false,
        units: TEAM_UNITS,
        units_map: Object.fromEntries(TEAM_UNITS.map((u) => [u, 'read'])),
      },
    });
    log.info({ teamId: team.id }, 'created git fleet team');
  }

  const { version } = await forgejo.json<{ version: string }>('/version');
  log.info({ version, org: env.GIT_ORG }, 'git server ready');
  return { version, teamId: team.id };
}

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await forgejo.healthy())) {
    if (Date.now() >= deadline) throw new GitError(`The git server at ${env.GIT_SERVER_URL} did not come up.`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function ensureAdmin(): Promise<void> {
  const probe = await forgejo.request('/user', { okStatuses: [401, 403] });
  if (probe.ok) return;

  const password = env.GIT_ADMIN_PASSWORD ?? '';
  const create = await dockerService.exec(
    env.GIT_CONTAINER,
    [
      'sh',
      '-c',
      `forgejo admin user create --admin --username '${env.GIT_ADMIN_USER}' ` +
        `--email '${env.GIT_ADMIN_USER}@pleiades.local' --must-change-password=false --password "$(cat)"`,
    ],
    { stdin: password, timeoutMs: 30_000 },
  );
  if (create.exitCode === 0) {
    log.info({ user: env.GIT_ADMIN_USER }, 'created git admin account');
    return;
  }
  // The account exists with another password (GIT_ADMIN_PASSWORD was changed): .env is the authority.
  if (/already exists/i.test(create.stderr + create.stdout)) {
    const change = await dockerService.exec(
      env.GIT_CONTAINER,
      [
        'sh',
        '-c',
        `forgejo admin user change-password --username '${env.GIT_ADMIN_USER}' --must-change-password=false --password "$(cat)"`,
      ],
      { stdin: password, timeoutMs: 30_000 },
    );
    if (change.exitCode === 0) {
      log.warn({ user: env.GIT_ADMIN_USER }, 'git admin password reset to GIT_ADMIN_PASSWORD');
      return;
    }
    throw new GitError(`Could not reset the git admin password: ${(change.stderr || change.stdout).trim()}`);
  }
  throw new GitError(
    `Could not create the git admin account in container ${env.GIT_CONTAINER}: ${(create.stderr || create.stdout).trim()}`,
  );
}
