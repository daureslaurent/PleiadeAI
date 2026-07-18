import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { encryptSecret } from '../../../isolation/ssh.service';
import { monitorTargetRepository } from '../../../domain/monitor/monitor-target.repository';
import { MonitorTargetError, monitorService } from '../../../domain/monitor/monitor.service';
import { monitorPoller } from '../../../domain/monitor/monitor.poller';
import { forget } from '../../../domain/monitor/monitor.alerts';
import type { MonitorTargetDoc } from '../../../domain/monitor/monitor-target.model';

const log = createLogger('monitor-routes');

/**
 * The Monitor page's API: CRUD for monitored machines (Settings → Monitor) plus the read side the
 * dashboard polls. Telemetry is served from the in-process poller, never fetched per request — one
 * backend poll feeds every open tab, and the browser can refresh as fast as it likes for free.
 */
export const monitorRouter = Router();

/**
 * Public projection. `api_key_enc` is `select: false` so it is normally absent; we strip it
 * defensively and expose only whether a key is set — the monitor-client secret never reaches the browser.
 */
function shape(t: MonitorTargetDoc) {
  return {
    _id: t._id,
    name: t.name,
    base_url: t.base_url,
    endpoint_id: t.endpoint_id ? String(t.endpoint_id) : null,
    enabled: t.enabled,
    note: t.note ?? '',
    has_api_key: Boolean(t.api_key_enc),
    created_at: (t as unknown as { created_at?: Date }).created_at,
    updated_at: (t as unknown as { updated_at?: Date }).updated_at,
  };
}

/**
 * An empty-string API key means "clear it"; an absent field means "leave it alone". Without that
 * distinction a PATCH that only renames a target would silently wipe its credential.
 */
function keyPatch(body: Record<string, unknown>): { api_key_enc?: string | null } {
  if (!('api_key' in body)) return {};
  const raw = typeof body.api_key === 'string' ? body.api_key : '';
  return { api_key_enc: raw ? encryptSecret(raw) : null };
}

// --- CRUD ---

monitorRouter.get('/targets', async (_req, res) => {
  const targets = await monitorTargetRepository.list();
  res.json(targets.map(shape));
});

monitorRouter.post('/targets', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim().replace(/\/+$/, '') : '';
  if (!name || !baseUrl) {
    res.status(400).json({ error: 'name and base_url are required' });
    return;
  }

  try {
    const target = await monitorTargetRepository.create({
      name,
      base_url: baseUrl,
      endpoint_id: typeof b.endpoint_id === 'string' && b.endpoint_id ? b.endpoint_id : null,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
      note: typeof b.note === 'string' ? b.note : '',
      ...keyPatch(b),
    });
    // Fill the dashboard now rather than leaving the new card blank until the next tick.
    void monitorPoller.refresh();
    res.status(201).json(shape(target));
  } catch (err) {
    // The only realistic failure is the unique-name index.
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not create target' });
  }
});

monitorRouter.patch('/targets/:id', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const patch: Parameters<typeof monitorTargetRepository.update>[1] = { ...keyPatch(b) };

  if (typeof b.name === 'string') patch.name = b.name.trim();
  if (typeof b.base_url === 'string') patch.base_url = b.base_url.trim().replace(/\/+$/, '');
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  if (typeof b.note === 'string') patch.note = b.note;
  if ('endpoint_id' in b) {
    patch.endpoint_id = (typeof b.endpoint_id === 'string' && b.endpoint_id ? b.endpoint_id : null) as never;
  }

  try {
    const target = await monitorTargetRepository.update(req.params.id, patch);
    if (!target) {
      res.status(404).json({ error: 'target not found' });
      return;
    }
    void monitorPoller.refresh();
    res.json(shape(target));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not update target' });
  }
});

monitorRouter.delete('/targets/:id', async (req, res) => {
  const target = await monitorTargetRepository.delete(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'target not found' });
    return;
  }
  forget(req.params.id);
  void monitorPoller.refresh();
  res.status(204).end();
});

/**
 * Probe a target right now and report what happened. This is the settings form's "Test" button: an
 * operator who typed a wrong URL or key needs the target's own error verbatim, not "offline".
 */
monitorRouter.post('/targets/:id/test', async (req, res) => {
  const target = await monitorTargetRepository.findByIdWithKey(req.params.id);
  if (!target) {
    res.status(404).json({ error: 'target not found' });
    return;
  }

  try {
    const { snapshot, latency_ms } = await monitorService.probe(target);
    res.json({
      ok: true,
      latency_ms,
      hostname: snapshot.host?.hostname ?? null,
      os: snapshot.host?.os ?? null,
      cpu: snapshot.cpu?.model ?? null,
      gpus: (snapshot.gpus ?? []).map((g) => g.name).filter(Boolean),
      warnings: snapshot.warnings ?? [],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status = err instanceof MonitorTargetError && err.status === 401 ? 401 : 502;
    log.warn({ target: target.name, err: detail }, 'monitor target test failed');
    res.status(status).json({ ok: false, error: detail });
  }
});

// --- Read side (served from the poller's memory) ---

/** Every enabled target's newest snapshot — the fleet grid. */
monitorRouter.get('/live', (_req, res) => {
  res.json(monitorPoller.live());
});

/**
 * Reduced history for the drill-down graphs. `?since=<epoch ms>` lets a page that already holds
 * history ask only for what's new instead of re-downloading the whole buffer every poll.
 */
monitorRouter.get('/targets/:id/history', (req, res) => {
  const since = Number(req.query.since);
  const samples = monitorPoller.history(req.params.id);
  res.json(Number.isFinite(since) && since > 0 ? samples.filter((s) => s.t > since) : samples);
});
