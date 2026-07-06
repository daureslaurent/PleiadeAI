import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { isolationRepository } from '../../../domain/isolations/isolation.repository';
import { imageRepository } from '../../../domain/images/image.repository';
import {
  agentContainerManager,
  type IsolatedAgent,
  type IsolationProfile,
} from '../../../isolation/AgentContainerManager';
import { dockerService } from '../../../isolation/docker.service';
import { agentContainerName, agentVolumeName, WORKSPACE_DIR } from '../../../isolation/names';
import { createLogger } from '../../../config/logger';

const log = createLogger('agent-container-routes');

/** Longest file the read-preview endpoint returns inline (bytes); larger files are truncated. */
const MAX_PREVIEW_BYTES = 512 * 1024;

/**
 * Normalise a caller-supplied path and confine it to the `/workspace` subtree. Returns `null` for
 * anything that escapes (via `..`, absolute paths elsewhere, or NUL bytes) so the caller can 400.
 */
function safeWorkspacePath(raw: unknown, { allowRoot = true }: { allowRoot?: boolean } = {}): string | null {
  const p = typeof raw === 'string' && raw.trim() ? raw.trim() : WORKSPACE_DIR;
  if (p.includes('\0')) return null;
  const norm = path.posix.normalize(p);
  if (norm !== WORKSPACE_DIR && !norm.startsWith(`${WORKSPACE_DIR}/`)) return null;
  if (!allowRoot && norm === WORKSPACE_DIR) return null;
  return norm;
}

/**
 * Per-agent container controls (mounted at `/api/agents/:id/container`). The image + profile live
 * on the Isolation page; these act on the individual agent's running container / individual volume.
 */
export const agentContainerRouter = Router({ mergeParams: true });

const agentId = (req: { params: Record<string, string | undefined> }): string =>
  String(req.params.id);

/**
 * Resolve the agent, confirm it is isolated, and confirm its container is currently running —
 * the precondition for every file-explorer / stats operation (which `docker exec` into it). On
 * failure it writes the response (`404`/`409` with a machine code the UI switches on) and returns
 * `null`; on success it returns the container name.
 */
async function requireRunningContainer(req: Request, res: Response): Promise<string | null> {
  const agent = await agentRepository.findById(String(req.params.id));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  if (!agent.isolation_id) {
    res.status(409).json({ error: 'no_isolation', message: 'agent has no isolation profile' });
    return null;
  }
  const container = agentContainerName(String(agent._id));
  const state = await dockerService.containerState(container);
  if (state !== 'running') {
    res.status(409).json({ error: 'not_running', message: 'container is not running', state: state ?? 'absent' });
    return null;
  }
  return container;
}

/** Live status of this agent's isolation: assigned profile, container state, volume presence. */
agentContainerRouter.get('/', async (req, res) => {
  const agent = await agentRepository.findById(agentId(req));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(agent._id);
  const iso = agent.isolation_id ? await isolationRepository.findById(agent.isolation_id) : null;
  const image = iso?.image_id ? await imageRepository.findById(String(iso.image_id)) : null;
  const [containerStateRaw, volumeExists] = await Promise.all([
    dockerService.containerState(agentContainerName(id)),
    dockerService.volumeExists(agentVolumeName(id)),
  ]);
  res.json({
    isolation_id: agent.isolation_id ? String(agent.isolation_id) : null,
    isolation_name: iso?.name ?? null,
    image_status: image?.image_status ?? null,
    volume_mode: agent.isolation_volume_mode,
    container_state: containerStateRaw ?? 'absent',
    individual_volume_exists: volumeExists,
  });
});

/** Stop the running container (keeps it + the volume; next use restarts it). */
agentContainerRouter.post('/stop', async (req, res) => {
  const agent = await agentRepository.findById(agentId(req));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await agentContainerManager.stopAgent(String(agent._id)).catch(() => undefined);
  res.status(204).end();
});

/**
 * Delete this agent's individual workspace volume (explicit, destructive). No-op for agents in
 * shared volume mode — that volume belongs to the isolation profile, not the agent.
 */
agentContainerRouter.delete('/volume', async (req, res) => {
  const agent = await agentRepository.findById(agentId(req));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (agent.isolation_volume_mode === 'shared') {
    res.status(409).json({ error: 'agent uses a shared volume; manage it from the isolation profile' });
    return;
  }
  const id = String(agent._id);
  await agentContainerManager.removeAgentContainer(id).catch(() => undefined);
  await dockerService.removeVolume(agentVolumeName(id)).catch((err) => {
    log.warn({ id, err: String(err) }, 'volume removal failed');
  });
  res.status(204).end();
});

/**
 * Boot the agent's container on demand (image build → create → start), so the Isolation tab can
 * bring it up without waiting for a chat turn. Mirrors what a tool call would trigger lazily.
 */
agentContainerRouter.post('/start', async (req, res) => {
  const agent = await agentRepository.findById(agentId(req));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!agent.isolation_id) {
    res.status(409).json({ error: 'no_isolation', message: 'agent has no isolation profile' });
    return;
  }
  const iso = await isolationRepository.findById(agent.isolation_id);
  if (!iso) {
    res.status(409).json({ error: 'no_isolation', message: 'isolation profile missing' });
    return;
  }
  try {
    await agentContainerManager.ensureReady(
      agent as unknown as IsolatedAgent,
      iso as unknown as IsolationProfile,
    );
    res.status(204).end();
  } catch (err) {
    res.status(409).json({ error: 'not_ready', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Boot the agent's live visual desktop (Xvfb + loopback VNC) and return the credentials the noVNC
 * client needs. Brings the container up first (like `/start`), then boots the desktop stack on
 * demand. The pixel stream itself flows over the WebSocket at `ws_path` (see the visual proxy) —
 * this endpoint is the authenticated handshake that hands back the one-per-container VNC password.
 * `409 not_ready` (with the underlying message) if the image lacks the visual layer or it times out.
 */
agentContainerRouter.post('/visual/session', async (req, res) => {
  const agent = await agentRepository.findById(agentId(req));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!agent.isolation_id) {
    res.status(409).json({ error: 'no_isolation', message: 'agent has no isolation profile' });
    return;
  }
  const iso = await isolationRepository.findById(agent.isolation_id);
  if (!iso) {
    res.status(409).json({ error: 'no_isolation', message: 'isolation profile missing' });
    return;
  }
  const id = String(agent._id);
  try {
    await agentContainerManager.ensureReady(
      agent as unknown as IsolatedAgent,
      iso as unknown as IsolationProfile,
    );
    const endpoint = await agentContainerManager.ensureVisual(id);
    res.json({ password: endpoint.password, ws_path: `/api/agents/${id}/container/visual/vnc` });
  } catch (err) {
    res.status(409).json({ error: 'not_ready', message: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Toggle human manual control of the visual desktop. `{ human: true }` when the operator takes over
 * in the noVNC panel (drops a lock the `visual_act` skill honours), `false` when they release it.
 */
agentContainerRouter.post('/visual/control', async (req, res) => {
  const agent = await agentRepository.findById(agentId(req));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const human = req.body?.human === true;
  await agentContainerManager.setVisualHumanControl(String(agent._id), human).catch((err) => {
    log.warn({ id: String(agent._id), err: String(err) }, 'visual control toggle failed');
  });
  res.status(204).end();
});

/** Live resource usage: `docker stats` (CPU/mem/net/block I/O) plus `/workspace` disk footprint. */
agentContainerRouter.get('/stats', async (req, res) => {
  const container = await requireRunningContainer(req, res);
  if (!container) return;

  const [statsRes, duRes] = await Promise.all([
    dockerService.run(['stats', '--no-stream', '--format', '{{json .}}', container]),
    dockerService.exec(container, ['du', '-sb', '--', WORKSPACE_DIR]),
  ]);

  let stats: Record<string, string> = {};
  try {
    stats = JSON.parse(statsRes.stdout.trim().split('\n')[0] || '{}');
  } catch {
    stats = {};
  }
  const workspaceBytes = Number(duRes.stdout.trim().split(/\s+/)[0]) || 0;

  res.json({
    cpu_perc: stats.CPUPerc ?? null,
    mem_usage: stats.MemUsage ?? null,
    mem_perc: stats.MemPerc ?? null,
    net_io: stats.NetIO ?? null,
    block_io: stats.BlockIO ?? null,
    pids: stats.PIDs ?? null,
    workspace_bytes: workspaceBytes,
  });
});

interface DirEntry {
  name: string;
  type: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtime: number;
}

/** List one directory level under `/workspace`. */
agentContainerRouter.get('/files', async (req, res) => {
  const dir = safeWorkspacePath(req.query.path);
  if (!dir) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const container = await requireRunningContainer(req, res);
  if (!container) return;

  // %y=type(f/d/l/…) %s=size %T@=mtime(epoch) %f=name — tab-separated, one entry per line.
  const out = await dockerService.exec(container, [
    'find', dir, '-maxdepth', '1', '-mindepth', '1', '-printf', '%y\\t%s\\t%T@\\t%f\\n',
  ]);
  if (out.exitCode !== 0) {
    res.status(404).json({ error: 'cannot list directory', detail: out.stderr.trim() });
    return;
  }

  const typeMap: Record<string, DirEntry['type']> = { f: 'file', d: 'dir', l: 'link' };
  const entries: DirEntry[] = out.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [y, s, t, ...rest] = line.split('\t');
      return {
        name: rest.join('\t'),
        type: typeMap[y ?? ''] ?? 'other',
        size: Number(s) || 0,
        mtime: Math.floor(Number(t) || 0),
      };
    })
    // Directories first, then case-insensitive name order.
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    );

  res.json({ path: dir, entries });
});

/** Inline preview of a text file (capped at 512 KiB; flags binary/truncated). */
agentContainerRouter.get('/file', async (req, res) => {
  const file = safeWorkspacePath(req.query.path, { allowRoot: false });
  if (!file) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const container = await requireRunningContainer(req, res);
  if (!container) return;

  const [head, statRes] = await Promise.all([
    dockerService.exec(container, ['head', '-c', String(MAX_PREVIEW_BYTES), '--', file]),
    dockerService.exec(container, ['stat', '-c', '%s', '--', file]),
  ]);
  if (statRes.exitCode !== 0) {
    res.status(404).json({ error: 'not a file', detail: statRes.stderr.trim() });
    return;
  }
  const size = Number(statRes.stdout.trim()) || 0;
  const binary = /\u0000/.test(head.stdout);
  res.json({
    path: file,
    size,
    truncated: size > MAX_PREVIEW_BYTES,
    binary,
    content: binary ? '' : head.stdout,
  });
});

/** Stream a file out of the container as a binary download. */
agentContainerRouter.get('/download', async (req, res) => {
  const file = safeWorkspacePath(req.query.path, { allowRoot: false });
  if (!file) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const container = await requireRunningContainer(req, res);
  if (!container) return;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.posix.basename(file).replace(/"/g, '')}"`);

  const child = dockerService.spawnRaw(['exec', container, 'cat', '--', file]);
  child.stdout.pipe(res);
  child.stderr.on('data', (d: Buffer) => log.warn({ file, err: d.toString() }, 'download stderr'));
  child.on('error', () => {
    if (!res.headersSent) res.status(500);
    res.end();
  });
  res.on('close', () => child.kill('SIGKILL'));
});

/** Upload a single file: the raw request body is streamed into the container at `?path=`. */
agentContainerRouter.put('/files', async (req, res) => {
  const file = safeWorkspacePath(req.query.path, { allowRoot: false });
  if (!file) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const container = await requireRunningContainer(req, res);
  if (!container) return;

  // `tee <path>` writes stdin to the file (argv, no shell); its stdout copy is discarded.
  const child = dockerService.spawnRaw(['exec', '-i', container, 'tee', '--', file]);
  child.stdout.resume();
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'upload failed' });
  });
  child.on('close', (code) => {
    if (res.headersSent) return;
    if (code === 0) res.status(204).end();
    else res.status(500).json({ error: 'upload failed', detail: stderr.trim() });
  });
  req.pipe(child.stdin);
  req.on('aborted', () => child.kill('SIGKILL'));
});

/** Delete a file or directory (recursive) under `/workspace` (never the workspace root itself). */
agentContainerRouter.delete('/files', async (req, res) => {
  const target = safeWorkspacePath(req.query.path, { allowRoot: false });
  if (!target) {
    res.status(400).json({ error: 'invalid path' });
    return;
  }
  const container = await requireRunningContainer(req, res);
  if (!container) return;

  const out = await dockerService.exec(container, ['rm', '-rf', '--', target]);
  if (out.exitCode !== 0) {
    res.status(500).json({ error: 'delete failed', detail: out.stderr.trim() });
    return;
  }
  res.status(204).end();
});
