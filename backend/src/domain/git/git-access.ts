import { env } from '../../config/env';
import { gitEnabled } from './forgejo.client';

/**
 * How an agent reaches the git server from where its commands run (GIT_SERVER_PLAN.md §1). One table,
 * read by both the container manager (which wires the network) and the prompt/tool (which tell the
 * agent the URL), so what an agent is told and what it can actually reach cannot disagree.
 *
 * - `bridge` — the container is attached to `pleiades_git_net`; docker DNS resolves the service name.
 * - `host`   — the container shares the host's netns and uses Forgejo's loopback-only bind.
 * - `vpn`    — the profile's gluetun is attached to the git network before it starts; the agent shares
 *              gluetun's netns, whose DNS can't resolve docker names, so it gets the fixed IP.
 * - `none`, `ssh`, no isolation — nothing to wire: offline, remote host, or the backend itself.
 */
export type GitAccess =
  | { available: true; url: string; wiring: 'network' | 'host' | 'gluetun' }
  | { available: false; reason: string };

export function gitAccessFor(iso: { network?: string | null } | null | undefined): GitAccess {
  if (!gitEnabled()) {
    return { available: false, reason: 'the internal git server is not configured on this instance' };
  }
  if (!iso) {
    return {
      available: false,
      reason: 'git is only reachable from an isolated container, and you have no isolation profile — ask the operator to assign one',
    };
  }
  const port = env.GIT_AGENT_PORT;
  switch (iso.network || env.AGENT_CONTAINER_NETWORK) {
    case 'bridge':
      return { available: true, url: `http://${env.GIT_AGENT_HOST}:${port}`, wiring: 'network' };
    case 'host':
      return { available: true, url: env.GIT_HOST_URL.replace(/\/+$/, ''), wiring: 'host' };
    case 'vpn':
      return { available: true, url: `http://${env.GIT_FORGEJO_IP}:${port}`, wiring: 'gluetun' };
    case 'none':
      return { available: false, reason: 'your isolation profile is offline (network: none)' };
    case 'ssh':
      return {
        available: false,
        reason: 'your commands run on a remote host over SSH, which cannot reach the internal git network',
      };
    default:
      return { available: false, reason: `network mode "${iso.network}" has no route to the git server` };
  }
}

/** `http://host:port` + org/repo → the clone URL an agent with this access should use. */
export function cloneUrl(baseUrl: string, repo: string): string {
  return `${baseUrl}/${env.GIT_ORG}/${repo}.git`;
}
