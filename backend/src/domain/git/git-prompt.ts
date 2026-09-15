import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import type { GitPromptState } from '../../modules/types';
import { gitEnabled } from './forgejo.client';
import { gitAccessFor } from './git-access';
import { gitIdentityService, usernameFor } from './git-identity.service';
import { gitRepoService } from './git-repo.service';

const log = createLogger('git-prompt');

/** Repos named in the block; the rest are a count and a pointer at `git_repos list`. */
const PROMPT_REPOS_MAX = 12;

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/**
 * What the Git block renders from (GIT_SERVER_PLAN.md §4), fetched by `AgentRunner` only when the
 * module is on and the agent has a shell. Null when this instance has no git server at all — then
 * there is nothing to say. Bounded: a slow git server degrades the block ("the list did not load")
 * rather than the turn.
 */
export async function gitPromptState(
  agent: { _id: unknown; name: string },
  iso: { network?: string | null } | null,
): Promise<GitPromptState | null> {
  if (!gitEnabled()) return null;
  const access = gitAccessFor(iso);
  if (!access.available) return { available: false, reason: access.reason };

  const ensure = gitIdentityService.ensure(agent);
  ensure.catch((err) => log.warn({ agentId: String(agent._id), err: String(err) }, 'git account not ready for the prompt'));
  const identity = await within(ensure.catch(() => undefined), 3_000);
  const username = identity?.username ?? usernameFor(agent);

  let repos: Awaited<ReturnType<typeof gitRepoService.listForAgent>> | undefined;
  if (identity) {
    repos = await gitRepoService.listForAgent(identity.username, 2_500).catch(() => undefined);
  }
  return {
    available: true,
    url: access.url,
    org: env.GIT_ORG,
    username,
    repos: (repos ?? []).slice(0, PROMPT_REPOS_MAX).map((r) => ({
      name: r.name,
      permission: r.permission === 'write' ? 'write' : 'read',
    })),
    more: Math.max(0, (repos?.length ?? 0) - PROMPT_REPOS_MAX),
    reposUnavailable: repos === undefined,
  };
}
