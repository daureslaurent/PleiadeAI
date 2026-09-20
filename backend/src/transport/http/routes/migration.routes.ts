import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { env } from '../../../config/env';
import { createLogger } from '../../../config/logger';
import { ARCHIVE_EXT, readArchiveHeader } from '../../../domain/migration/archive';
import {
  estimateArchiveBytes,
  takeFingerprint,
} from '../../../domain/migration/fingerprint';
import { activeEncKeyFingerprint } from '../../../domain/migration/env-snapshot';
import { plannedCollections, runExport } from '../../../domain/migration/export.service';
import { runPreflight, runRestore } from '../../../domain/migration/import.service';
import { clearJob, currentJob, JobBusyError, startJob } from '../../../domain/migration/job';
import { inMaintenance, maintenanceReason, leaveMaintenance } from '../../../domain/migration/maintenance-mode';
import { restartSelf } from '../../../domain/migration/restart';
import {
  archivePath,
  deleteArchive,
  ensureDirs,
  freeBytes,
  isValidId,
  listArchives,
  newId,
  promoteUpload,
  readRecord,
  uploadPath,
} from '../../../domain/migration/storage';

const log = createLogger('migration-routes');

/**
 * Whole-instance migration (Settings → Instance migration, spec `INSTANCE_MIGRATION_PLAN.md`).
 *
 * Distinct from `transfer.routes.ts`, which merges *some agents* into a foreign fleet by name and
 * strips every credential on the way out. This router moves the entire instance — ids, GridFS
 * bytes, vector memory and re-wrapped credentials — so that after the move nobody can tell.
 *
 * Every mutating route here is a POST, so an API key (read-only unless scoped, see
 * `middleware/auth.ts`) can enumerate archives but can never start a restore.
 */
export const migrationRouter = Router();

function requirePassphrase(req: Request, res: Response): string | null {
  const passphrase = (req.body ?? {}).passphrase;
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    res.status(400).json({ error: 'a passphrase of at least 8 characters is required' });
    return null;
  }
  return passphrase;
}

/** Everything the page needs on load: what is here, what exists already, and what is running. */
migrationRouter.get('/overview', async (_req, res) => {
  await ensureDirs();
  const fingerprint = await takeFingerprint();
  const collections = await plannedCollections({ excludeInferenceLogs: false, excludeMedia: false });
  const [estimate, free, archives] = await Promise.all([
    estimateArchiveBytes(collections),
    freeBytes(),
    listArchives(),
  ]);
  res.json({
    fingerprint,
    estimate_bytes: estimate,
    free_bytes: free,
    archives,
    job: currentJob(),
    maintenance: { active: inMaintenance(), reason: maintenanceReason() },
    enc_key_fingerprint: activeEncKeyFingerprint(),
    upload_chunk_max_bytes: env.BACKUP_UPLOAD_CHUNK_MAX_BYTES,
  });
});

migrationRouter.get('/job', (_req, res) => {
  res.json({ job: currentJob() });
});

migrationRouter.delete('/job', (_req, res) => {
  res.json({ cleared: clearJob() });
});

migrationRouter.get('/archives', async (_req, res) => {
  res.json({ archives: await listArchives() });
});

// --- Export ---------------------------------------------------------------------------------

migrationRouter.post('/export', async (req, res) => {
  const passphrase = requirePassphrase(req, res);
  if (!passphrase) return;
  const body = req.body ?? {};
  const opts = {
    passphrase,
    includeEnv: body.includeEnv !== false,
    excludeInferenceLogs: body.excludeInferenceLogs === true,
    excludeMedia: body.excludeMedia === true,
    label: typeof body.label === 'string' ? body.label.slice(0, 200) : undefined,
  };
  try {
    const job = startJob('export', newId(), (progress) => runExport(opts, progress));
    res.status(202).json({ job });
  } catch (err) {
    if (err instanceof JobBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * Stream an archive to the browser, honouring `Range`.
 *
 * Range support is the difference between a usable download and an unusable one at this size: a
 * multi-GB transfer that drops at 90% otherwise starts again from zero, and the browser's own
 * resume is the only retry the operator gets.
 */
migrationRouter.get('/archives/:id/download', async (req, res) => {
  const { id } = req.params;
  const record = await readRecord(id);
  if (!record) {
    res.status(404).json({ error: 'no such archive' });
    return;
  }
  const file = archivePath(id);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    res.status(404).json({ error: 'archive file is missing' });
    return;
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${record.filename}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  if (record.sha256) res.setHeader('X-Archive-Sha256', record.sha256);

  const range = req.headers.range;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (match) {
    const start = match[1] === '' ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]);
    const end = match[2] === '' || match[1] === '' ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
    if (Number.isNaN(start) || start >= stat.size || end < start) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(stat.size));
  fs.createReadStream(file).pipe(res);
});

migrationRouter.delete('/archives/:id', async (req, res) => {
  res.json({ deleted: await deleteArchive(req.params.id) });
});

// --- Upload (resumable) ----------------------------------------------------------------------

/**
 * Chunked upload, because the archive is measured in gigabytes.
 *
 * Multer is deliberately not used here even though it is already a dependency: its memory storage
 * would hold the whole body, and its disk storage still buffers a whole request. Chunks are piped
 * straight to the file, and `PUT` is addressed by byte offset so a dropped connection resumes from
 * whatever `GET /uploads/:id` reports rather than starting the transfer again.
 */
migrationRouter.post('/uploads', async (_req, res) => {
  await ensureDirs();
  const id = newId();
  await fs.promises.writeFile(uploadPath(id), '');
  res.status(201).json({ upload_id: id, received: 0, chunk_max_bytes: env.BACKUP_UPLOAD_CHUNK_MAX_BYTES });
});

migrationRouter.get('/uploads/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'bad upload id' });
    return;
  }
  try {
    const stat = await fs.promises.stat(uploadPath(id));
    res.json({ upload_id: id, received: stat.size });
  } catch {
    res.status(404).json({ error: 'no such upload' });
  }
});

migrationRouter.put('/uploads/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'bad upload id' });
    return;
  }
  const file = uploadPath(id);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    res.status(404).json({ error: 'no such upload' });
    return;
  }

  // The client says where it believes it is; a mismatch means the two sides disagree about what
  // arrived, and appending anyway would corrupt the archive in a way only the restore would find.
  const offset = Number(req.query.offset ?? stat.size);
  if (!Number.isInteger(offset) || offset !== stat.size) {
    res.status(409).json({ error: 'offset mismatch', received: stat.size });
    return;
  }

  const out = fs.createWriteStream(file, { flags: 'a' });
  let written = 0;
  req.on('data', (c: Buffer) => {
    written += c.length;
    if (written > env.BACKUP_UPLOAD_CHUNK_MAX_BYTES) req.destroy(new Error('chunk too large'));
  });
  req.pipe(out);

  out.on('finish', () => res.json({ upload_id: id, received: stat.size + written }));
  out.on('error', (err) => {
    log.error({ err, id }, 'upload chunk failed');
    if (!res.headersSent) res.status(500).json({ error: 'write failed' });
  });
  req.on('error', () => {
    out.destroy();
    if (!res.headersSent) res.status(400).json({ error: 'chunk aborted' });
  });
});

migrationRouter.post('/uploads/:id/complete', async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'bad upload id' });
    return;
  }
  try {
    const record = await promoteUpload(id, typeof req.body?.note === 'string' ? req.body.note : undefined);
    res.status(201).json({ archive: record });
  } catch (err) {
    // A failed header parse means the bytes are not one of ours — say so plainly rather than
    // letting the operator discover it at the passphrase prompt.
    await fs.promises.unlink(uploadPath(id)).catch(() => undefined);
    res.status(400).json({ error: err instanceof Error ? err.message : 'upload is not a valid archive' });
  }
});

/** Header-only peek, so the import page can name an archive before a passphrase is typed. */
migrationRouter.get('/archives/:id/header', async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'bad archive id' });
    return;
  }
  try {
    const { header } = await readArchiveHeader(archivePath(id));
    res.json({ header });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'unreadable archive' });
  }
});

// --- Import ---------------------------------------------------------------------------------

migrationRouter.post('/archives/:id/preflight', async (req, res) => {
  const { id } = req.params;
  const passphrase = requirePassphrase(req, res);
  if (!passphrase) return;
  if (!(await readRecord(id))) {
    res.status(404).json({ error: 'no such archive' });
    return;
  }
  try {
    const job = startJob('preflight', id, (progress) => runPreflight(id, passphrase, progress));
    res.status(202).json({ job });
  } catch (err) {
    if (err instanceof JobBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * **Destructive.** Replaces this instance with the archive's, then restarts the backend.
 *
 * `confirm: 'REPLACE'` mirrors the clone import's guard and the data reset's `CLEAR`: a restore can
 * never fire on a stray POST, and the word is the same shape the operator already knows.
 */
migrationRouter.post('/archives/:id/restore', async (req, res) => {
  const { id } = req.params;
  const body = req.body ?? {};
  if (body.confirm !== 'REPLACE') {
    res.status(400).json({ error: "refusing to restore: pass { confirm: 'REPLACE' }" });
    return;
  }
  const passphrase = requirePassphrase(req, res);
  if (!passphrase) return;

  const record = await readRecord(id);
  if (!record) {
    res.status(404).json({ error: 'no such archive' });
    return;
  }
  if (!record.verified_at) {
    res.status(412).json({ error: 'run a preflight on this archive first' });
    return;
  }

  try {
    const job = startJob('restore', id, async (progress) => {
      const report = await runRestore(id, passphrase, progress);
      progress.phase('Restarting the backend');
      // Give the UI one poll interval to read the finished job before the process goes away.
      const restart = await new Promise<{ requested: boolean; detail: string }>((resolve) => {
        setTimeout(() => void restartSelf().then(resolve), 2_000);
      });
      if (!restart.requested) {
        progress.warn(`Could not restart automatically (${restart.detail}). Run: docker compose restart backend`);
      }
      return { ...report, restart_requested: restart.requested };
    });
    res.status(202).json({ job });
  } catch (err) {
    if (err instanceof JobBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** Manual restart, for when the automatic one could not reach the docker socket. */
migrationRouter.post('/restart', async (_req, res) => {
  const result = await restartSelf();
  res.json(result);
});

/** Escape hatch for a restore that failed: put the instance back to work without a restart. */
migrationRouter.post('/leave-maintenance', async (_req, res) => {
  await leaveMaintenance();
  res.json({ maintenance: { active: inMaintenance(), reason: maintenanceReason() } });
});

/** Guard against a path that isn't ours ever reaching the filesystem helpers. */
export function isInsideBackupDir(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved.startsWith(path.resolve(env.BACKUP_DIR) + path.sep) && resolved.endsWith(ARCHIVE_EXT);
}
