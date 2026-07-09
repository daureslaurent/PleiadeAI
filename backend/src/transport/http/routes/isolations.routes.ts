import { Router } from 'express';
import { isolationRepository } from '../../../domain/isolations/isolation.repository';
import { imageRepository } from '../../../domain/images/image.repository';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { agentContainerManager } from '../../../isolation/AgentContainerManager';
import { dockerService } from '../../../isolation/docker.service';
import {
  isoSharedVolumeName,
  isoGluetunName,
  agentContainerName,
  agentVolumeName,
  agentIdFromContainerName,
} from '../../../isolation/names';
import { encryptSecret } from '../../../isolation/ssh.service';
import { generateSshKeyPair } from '../../../isolation/ssh-keygen';
import { parseWireguardConf } from '../../../isolation/vpn.service';
import { createLogger } from '../../../config/logger';

const log = createLogger('isolations-routes');

/** CRUD + build/lifecycle for shared Docker isolation profiles (`/api/isolations`). */
export const isolationsRouter = Router();

const idsOf = async (isoId: string): Promise<string[]> =>
  (await agentRepository.listByIsolation(isoId)).map((a) => String(a._id));

isolationsRouter.get('/', async (_req, res) => {
  res.json(await isolationRepository.list());
});

/**
 * Global overview of every pleiades-managed container across all profiles (agent containers +
 * gluetun VPN containers), classified against current Mongo state so stale/orphaned instances are
 * flagged. Declared before `/:id` so `containers` isn't matched as a profile id.
 *
 * A container is `orphan` when it no longer maps to live config: its agent was deleted or is no
 * longer assigned to a profile, or its profile was deleted / no longer uses VPN. Non-orphans are
 * listed too so the operator can stop/remove any running instance from one place.
 */
isolationsRouter.get('/containers', async (_req, res) => {
  const [containers, agents, isolations] = await Promise.all([
    dockerService.listManagedContainers(),
    agentRepository.list(),
    isolationRepository.list(),
  ]);
  const agentById = new Map(agents.map((a) => [String(a._id), a]));
  const isoById = new Map(isolations.map((i) => [String(i._id), i]));

  const rows = containers.map((c) => {
    if (c.agentId) {
      const agent = agentById.get(c.agentId);
      const isoId = agent?.isolation_id ? String(agent.isolation_id) : undefined;
      const iso = isoId ? isoById.get(isoId) : undefined;
      let orphan = false;
      let reason: string | undefined;
      if (!agent) {
        orphan = true;
        reason = 'agent was deleted';
      } else if (!isoId) {
        orphan = true;
        reason = 'agent is no longer assigned to an isolation profile';
      } else if (!iso) {
        orphan = true;
        reason = 'isolation profile was deleted';
      }
      return {
        kind: 'agent' as const,
        container: c.name,
        state: c.state,
        agent_id: c.agentId,
        agent_name: agent?.name,
        isolation_id: isoId,
        isolation_name: iso?.name,
        orphan,
        reason,
      };
    }
    // gluetun VPN container (labelled with the isolation id).
    const iso = c.isolationId ? isoById.get(c.isolationId) : undefined;
    let orphan = false;
    let reason: string | undefined;
    if (!iso) {
      orphan = true;
      reason = 'isolation profile was deleted';
    } else if (iso.network !== 'vpn') {
      orphan = true;
      reason = 'profile no longer uses VPN';
    }
    return {
      kind: 'gluetun' as const,
      container: c.name,
      state: c.state,
      isolation_id: c.isolationId,
      isolation_name: iso?.name,
      orphan,
      reason,
    };
  });

  // Orphans first, then by name, so the cleanup candidates surface at the top.
  rows.sort((a, b) => Number(b.orphan) - Number(a.orphan) || a.container.localeCompare(b.container));
  res.json(rows);
});

/**
 * Remove a single managed container by name. Validated against the live managed-container list so
 * only pleiades-labelled containers can be targeted. Agent containers go through the manager (clears
 * the idle-stop timer); gluetun containers are removed directly.
 */
isolationsRouter.delete('/containers/:name', async (req, res) => {
  const name = req.params.name;
  const managed = await dockerService.listManagedContainers();
  const match = managed.find((c) => c.name === name);
  if (!match) {
    res.status(404).json({ error: 'not a managed container' });
    return;
  }
  try {
    if (match.agentId) await agentContainerManager.removeAgentContainer(match.agentId);
    else await dockerService.removeContainer(name);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.status(204).end();
});

isolationsRouter.get('/:id', async (req, res) => {
  const iso = await isolationRepository.findById(req.params.id);
  if (!iso) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(iso);
});

/** Live docker state + Dockerfile lint warnings + how many agents reference this profile. */
isolationsRouter.get('/:id/status', async (req, res) => {
  const iso = await isolationRepository.findById(req.params.id);
  if (!iso) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(iso._id);
  const [sharedVolumeExists, assigned, sshKeySet, vpnConfSet, sudoPasswordSet, vpnState, image] =
    await Promise.all([
      dockerService.volumeExists(isoSharedVolumeName(id)),
      agentRepository.listByIsolation(id),
      isolationRepository.hasSshKey(id),
      isolationRepository.hasVpnConf(id),
      isolationRepository.hasSudoPassword(id),
      dockerService.containerState(isoGluetunName(id)),
      iso.image_id ? imageRepository.findById(String(iso.image_id)) : Promise.resolve(null),
    ]);

  // One running instance (container) per assigned agent, built from this profile's image.
  const instances = await Promise.all(
    assigned.map(async (a) => {
      const agentId = String(a._id);
      const container = agentContainerName(agentId);
      const state = await dockerService.containerState(container);
      return {
        agent_id: agentId,
        agent_name: a.name,
        container,
        state: state ?? 'absent',
        volume_mode: a.isolation_volume_mode,
        volume:
          a.isolation_volume_mode === 'shared' ? isoSharedVolumeName(id) : agentVolumeName(agentId),
      };
    }),
  );

  // Volumes belonging to this profile: the one shared workspace volume, plus each assigned agent's
  // individual volume. We report existence, creation time, and which containers hold it (→ in-use).
  const candidates: Array<{
    name: string;
    scope: 'shared' | 'individual';
    agent_id?: string;
    agent_name?: string;
    mode?: 'shared' | 'individual';
  }> = [{ name: isoSharedVolumeName(id), scope: 'shared' }];
  for (const a of assigned) {
    candidates.push({
      name: agentVolumeName(String(a._id)),
      scope: 'individual',
      agent_id: String(a._id),
      agent_name: a.name,
      mode: a.isolation_volume_mode,
    });
  }
  const volumesRaw = await Promise.all(
    candidates.map(async (c) => {
      const info = await dockerService.inspectVolume(c.name);
      const usedBy = info ? await dockerService.containersUsingVolume(c.name) : [];
      return {
        name: c.name,
        scope: c.scope,
        agent_id: c.agent_id,
        agent_name: c.agent_name,
        mode: c.mode,
        exists: !!info,
        created_at: info?.createdAt ?? null,
        mountpoint: info?.mountpoint ?? null,
        in_use: usedBy.length > 0,
        used_by: usedBy.map((u) => ({
          container: u.name,
          state: u.state,
          running: u.state === 'running',
        })),
      };
    }),
  );
  // Hide never-created individual volumes for agents that don't use individual mode (pure noise);
  // keep them when the volume exists (a leftover from a mode switch worth cleaning up).
  const volumes = volumesRaw
    .filter((v) => v.scope === 'shared' || v.exists || v.mode === 'individual')
    .map(({ mode: _mode, ...v }) => v);

  res.json({
    image_id: iso.image_id ? String(iso.image_id) : null,
    image_name: image?.name ?? null,
    image_status: image?.image_status ?? null,
    shared_volume_exists: sharedVolumeExists,
    assigned_agents: assigned.map((a) => ({ _id: String(a._id), name: a.name })),
    instances,
    volumes,
    ssh_key_set: sshKeySet,
    vpn_conf_set: vpnConfSet,
    sudo_password_set: sudoPasswordSet,
    vpn_state: vpnState ?? 'absent',
  });
});

/**
 * Delete one of this profile's workspace volumes (its shared volume, or an assigned agent's
 * individual volume). A volume can't be removed while a container mounts it, so `?force=1` first
 * tears down the referencing agent container(s) — they are recreated fresh on the agent's next run.
 * Without `force`, an in-use volume returns 409 so the operator can decide.
 */
isolationsRouter.delete('/:id/volumes/:name', async (req, res) => {
  const iso = await isolationRepository.findById(req.params.id);
  if (!iso) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(iso._id);
  const name = req.params.name;
  const force = req.query.force === '1' || req.query.force === 'true';

  // Scope guard: only this profile's own volumes may be deleted here.
  const assignedIds = await idsOf(id);
  const owned = new Set([isoSharedVolumeName(id), ...assignedIds.map(agentVolumeName)]);
  if (!owned.has(name)) {
    res.status(403).json({ error: 'volume is not part of this isolation profile' });
    return;
  }

  const users = await dockerService.containersUsingVolume(name);
  if (users.length > 0 && !force) {
    res.status(409).json({ error: 'volume is in use', used_by: users });
    return;
  }

  // Force path: remove the container(s) holding the volume first (via the manager so idle timers are
  // cleared), then the volume itself.
  for (const u of users) {
    const agentId = agentIdFromContainerName(u.name);
    if (agentId) await agentContainerManager.removeAgentContainer(agentId).catch(() => undefined);
    else await dockerService.removeContainer(u.name).catch(() => undefined);
  }
  try {
    await dockerService.removeVolume(name);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  res.status(204).end();
});

isolationsRouter.post('/', async (req, res) => {
  const { vpn_conf, sudo_password, ...body } = req.body ?? {};
  const input: Record<string, unknown> = { ...body };
  // A `.conf` uploaded at create time is validated + encrypted, same as the PATCH path.
  if (typeof vpn_conf === 'string' && vpn_conf.trim()) {
    try {
      parseWireguardConf(vpn_conf.trim());
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    input.vpn_conf_enc = encryptSecret(vpn_conf.trim());
  }
  // Optional remote sudo password (write-only), encrypted at rest like the SSH key.
  if (typeof sudo_password === 'string' && sudo_password.trim()) {
    input.sudo_password_enc = encryptSecret(sudo_password.trim());
  }
  // Empty image_id means "no image assigned".
  if (input.image_id === '') input.image_id = null;
  const iso = await isolationRepository.create(
    input as Parameters<typeof isolationRepository.create>[0],
  );
  res.status(201).json(iso);
});

/**
 * PATCH profile fields. When a resource/network setting changes, drop assigned agents' containers
 * so they're recreated with the new policy on next use.
 */
isolationsRouter.patch('/:id', async (req, res) => {
  const iso = await isolationRepository.findById(req.params.id);
  if (!iso) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(iso._id);
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'image_id', 'cpus', 'memory', 'network', 'idle_timeout_ms', 'ssh_public_key', 'ssh_known_hosts'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  // Empty image_id means "unassign the image".
  if (patch.image_id === '') patch.image_id = null;

  // Private key is write-only: a non-empty value is encrypted and stored; an explicit empty string
  // clears it; absence leaves it unchanged. The plaintext key is never persisted or echoed back.
  let sshChanged = false;
  if (typeof body.ssh_private_key === 'string') {
    const trimmed = body.ssh_private_key.trim();
    patch.ssh_private_key_enc = trimmed ? encryptSecret(trimmed) : null;
    // A hand-pasted key has an unknown algorithm — reset the type to '' (→ id_ed25519 filename, the
    // documented manual convention) so a leftover 'rsa' from a prior generate doesn't misname it.
    patch.ssh_key_type = '';
    sshChanged = true;
  }

  // WireGuard `.conf` is write-only, same convention as the SSH key (encrypt / clear / keep). A
  // non-empty upload is validated (parsed) before storing so a malformed file is rejected here
  // rather than silently failing when gluetun starts.
  let vpnChanged = false;
  if (typeof body.vpn_conf === 'string') {
    const trimmed = body.vpn_conf.trim();
    if (trimmed) {
      try {
        parseWireguardConf(trimmed);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      patch.vpn_conf_enc = encryptSecret(trimmed);
    } else {
      patch.vpn_conf_enc = null;
    }
    vpnChanged = true;
  }

  // Remote sudo password is write-only, same convention as the SSH key (encrypt / clear / keep).
  let sudoChanged = false;
  if (typeof body.sudo_password === 'string') {
    const trimmed = body.sudo_password.trim();
    patch.sudo_password_enc = trimmed ? encryptSecret(trimmed) : null;
    sudoChanged = true;
  }

  // A VPN config or network-mode change invalidates the profile's gluetun container: drop it so it
  // rebuilds from the new config on next use (and, below, recreate the agent containers that share
  // its netns).
  if (vpnChanged || patch.network !== undefined) {
    await agentContainerManager.teardownGluetun(id).catch(() => undefined);
  }

  // Recreate assigned containers when the runtime policy, SSH material, or VPN config changes, so
  // the new settings/keys take effect on next use.
  const needsRecreate =
    patch.image_id !== undefined ||
    patch.cpus !== undefined ||
    patch.memory !== undefined ||
    patch.network !== undefined ||
    sshChanged ||
    vpnChanged ||
    sudoChanged ||
    patch.ssh_public_key !== undefined ||
    patch.ssh_known_hosts !== undefined;
  if (needsRecreate) {
    for (const agentId of await idsOf(id)) {
      await agentContainerManager.removeAgentContainer(agentId).catch(() => undefined);
    }
  }

  res.json(await isolationRepository.update(id, patch));
});

/**
 * Generate a fresh outbound SSH keypair server-side and store it on the profile. The private key is
 * created, encrypted at rest, and injected into agent containers — it is NEVER returned to the
 * client. Only the public key (an `authorized_keys` line) comes back, to paste onto the remote host.
 * Overwrites any existing key (the caller confirms first), so assigned containers are recreated to
 * pick up the new key on next use.
 */
isolationsRouter.post('/:id/ssh/generate', async (req, res) => {
  const iso = await isolationRepository.findById(req.params.id);
  if (!iso) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(iso._id);
  const type = req.body?.type === 'rsa' ? 'rsa' : 'ed25519';
  const key = await generateSshKeyPair(type, `pleiades-${iso.name}`);
  await isolationRepository.update(id, {
    ssh_private_key_enc: encryptSecret(key.privateKey),
    ssh_public_key: key.publicKey,
    ssh_key_type: key.keyType,
  });
  // New key → recreate assigned containers so it installs on next run (matches the PATCH SSH path).
  for (const agentId of await idsOf(id)) {
    await agentContainerManager.removeAgentContainer(agentId).catch(() => undefined);
  }
  log.info({ id, keyType: key.keyType }, 'generated ssh key for isolation profile');
  res.json({ ssh_public_key: key.publicKey, ssh_key_type: key.keyType });
});

/**
 * Delete a profile: tear down every assigned agent's container + shared volume, unassign all
 * agents, then remove the document. The image is left intact (it belongs to the Image entity and
 * may back other profiles). Individual agent volumes are left intact too.
 */
isolationsRouter.delete('/:id', async (req, res) => {
  const iso = await isolationRepository.findById(req.params.id);
  if (!iso) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(iso._id);
  const agentIds = await idsOf(id);
  await agentContainerManager
    .teardownIsolation(id, agentIds, { removeSharedVolume: true })
    .catch((err) => log.warn({ id, err: String(err) }, 'isolation teardown failed'));
  await agentRepository.unassignIsolation(id);
  await isolationRepository.delete(id);
  res.status(204).end();
});
