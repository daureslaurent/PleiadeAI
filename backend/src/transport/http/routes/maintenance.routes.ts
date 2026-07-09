import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { dataResetService, parseCategories } from '../../../domain/maintenance/data-reset.service';

const log = createLogger('maintenance-routes');

/**
 * Instance maintenance (Settings → danger zone). Currently a single capability: clearing operational
 * data (conversations, scores, inference logs, activity) while preserving agents/isolations/images/
 * memory. The wipe is a POST, so a read-only API key can never trigger it (see middleware/auth.ts).
 */
export const maintenanceRouter = Router();

/** Per-collection row counts, so the confirm dialog can say exactly what it will delete. */
maintenanceRouter.get('/data-counts', async (_req, res) => {
  res.json(await dataResetService.counts());
});

/**
 * Download a restorable backup of the selected categories, e.g. `?categories=conversations,scores`.
 * Streamed as an attachment; the client offers this before a clear when the operator opts in.
 */
maintenanceRouter.get('/export', async (req, res) => {
  const categories = parseCategories(req.query.categories);
  if (categories.length === 0) {
    res.status(400).json({ error: 'no valid categories given' });
    return;
  }
  const bundle = await dataResetService.exportData(categories);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pleiades-data-backup-${Date.now()}.json"`);
  res.send(JSON.stringify(bundle));
});

/**
 * **Destructive.** Empties the selected categories. Requires `{ confirm: 'CLEAR' }` so it can never
 * fire on an accidental POST, mirroring the clone import's `REPLACE` guard.
 */
maintenanceRouter.post('/clear', async (req, res) => {
  const body = req.body ?? {};
  if (body.confirm !== 'CLEAR') {
    res.status(400).json({ error: "refusing to clear: pass { confirm: 'CLEAR' }" });
    return;
  }
  const categories = parseCategories(body.categories);
  if (categories.length === 0) {
    res.status(400).json({ error: 'no valid categories given' });
    return;
  }
  const summary = await dataResetService.clear(categories);
  log.warn({ categories, total: summary.total }, 'data cleared via API');
  res.json({ ok: true, ...summary });
});
