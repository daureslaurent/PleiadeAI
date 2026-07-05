import { Router, type Request, type Response } from 'express';
import {
  requestUpdate,
  getUpdateReadiness,
  readUpdateStatus,
  runUpdateCheck,
  readUpdateLog,
  getUpdateLogSize,
} from '../../../host';
import { settingsService } from '../../../domain/settings/settings.service';
import { createLogger } from '../../../config/logger';

const log = createLogger('host-routes');

/** Host self-update endpoints (spec: update system ported from cryptoBot). */
export const hostRouter = Router();

// Update status: whether the action is usable (feature toggle + host bind mount wired up)
// plus the last known origin/master comparison. `updateAvailable` drives the sidebar pin
// and is fetched on load (so it survives a page reload).
hostRouter.get('/update', async (_req: Request, res: Response) => {
  try {
    const enabled = (await settingsService.get()).update_enabled;
    const readiness = await getUpdateReadiness();
    const status = await readUpdateStatus();
    const updateAvailable = enabled && !!status && status.behindBy > 0;
    res.json({ enabled, ...readiness, status, updateAvailable });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Run a check now (read-only: host git fetch + status.json). Gated by the bridge being
// ready; independent of whether an update has been authorized to execute.
hostRouter.post('/update/check', async (_req: Request, res: Response) => {
  const readiness = await getUpdateReadiness();
  if (!readiness.ready) {
    res.status(503).json({ error: `Update host bridge not ready: ${readiness.reason}` });
    return;
  }
  try {
    const status = await runUpdateCheck();
    const enabled = (await settingsService.get()).update_enabled;
    const updateAvailable = enabled && !!status && status.behindBy > 0;
    res.json({ enabled, ...readiness, status, updateAvailable });
  } catch (err) {
    log.error({ err }, 'manual update check failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Signal the host watcher to pull latest master and rebuild/restart the stack. Gated by
// the update_enabled setting so the action can't fire unless explicitly turned on. This
// only drops a trigger file — the actual update runs on the host.
hostRouter.post('/update', async (_req: Request, res: Response) => {
  if (!(await settingsService.get()).update_enabled) {
    res.status(403).json({ error: 'App updates are disabled. Enable them in Settings → System & Updates first.' });
    return;
  }
  const readiness = await getUpdateReadiness();
  if (!readiness.ready) {
    res.status(503).json({ error: `Update host bridge not ready: ${readiness.reason}` });
    return;
  }
  try {
    // Capture the log's current size *before* triggering so the overlay can tail only this
    // run's output (the log is append-only across updates).
    const logOffset = await getUpdateLogSize();
    await requestUpdate({ by: 'web' });
    log.warn('host self-update requested via web');
    res.json({ ok: true, logOffset });
  } catch (err) {
    log.error({ err }, 'host update trigger failed');
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Tail the host update log. `since` is a byte offset (from the trigger response or the
// previous poll); returns only newly-appended text plus the next offset. Read-only and
// cheap — the overlay polls this while the stack rebuilds/restarts.
hostRouter.get('/update/log', async (req: Request, res: Response) => {
  const since = Number(req.query.since);
  try {
    res.json(await readUpdateLog(Number.isFinite(since) ? since : 0));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
