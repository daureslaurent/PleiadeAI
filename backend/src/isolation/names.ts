import { env } from '../config/env';

/**
 * Deterministic Docker resource names.
 *
 * Isolation profiles own the shared **image** and the shared **volume** (for agents that opt into
 * shared workspaces). Agents own their **container** and, in individual mode, their own **volume**.
 * All derived from Mongo `_id`s so they're stable across restarts and collision-free.
 */
const P = () => env.AGENT_IMAGE_PREFIX;

/** Shared image built once per isolation profile. @deprecated images are their own entity now. */
export function isoImageName(isolationId: string): string {
  return `${P()}_iso_${isolationId}:latest`;
}

/**
 * Image built from a standalone `Image` entity (own Dockerfile + build options). Isolation
 * profiles reference one of these via `image_id`; agent containers are created from its tag.
 */
export function imgImageName(imageId: string): string {
  return `${P()}_img_${imageId}:latest`;
}

/** Shared workspace volume for agents on a profile that use `shared` volume mode. */
export function isoSharedVolumeName(isolationId: string): string {
  return `${P()}_iso_ws_${isolationId}`;
}

/** Dedicated gluetun (VPN) container for a profile in `vpn` network mode. One per profile; the
 * profile's agent containers attach to its netns via `--network container:<this>`. */
export function isoGluetunName(isolationId: string): string {
  return `${P()}_iso_vpn_${isolationId}`;
}

/** Per-agent container (each assigned agent runs its own, from the profile's image). */
export function agentContainerName(agentId: string): string {
  return `${P()}_agent_${agentId}`;
}

/** Per-agent workspace volume, used when the agent is in `individual` volume mode. */
export function agentVolumeName(agentId: string): string {
  return `${P()}_agent_ws_${agentId}`;
}

/** Inverse of `agentContainerName`: recover the agentId from a container name, or `null`. */
export function agentIdFromContainerName(name: string): string | null {
  const prefix = `${P()}_agent_`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  // `_agent_ws_*` is a volume, not a container — guard against a mis-parse.
  return rest && !rest.startsWith('ws_') ? rest : null;
}

/** Directory inside the agent container that holds the skill harnesses (`docker cp`'d at create). */
export const HARNESS_DIR = '/opt/pleiades';
/** Working directory (backed by the persistent volume) for bash + skills inside the container. */
export const WORKSPACE_DIR = '/workspace';
