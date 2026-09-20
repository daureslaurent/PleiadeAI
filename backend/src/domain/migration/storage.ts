import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { ARCHIVE_EXT, readArchiveHeader } from './archive';
import type { Fingerprint } from './fingerprint';

const log = createLogger('migration-storage');

/**
 * The backup volume (`pleiades_backup_data:/app/backups`) where a built archive waits to be
 * downloaded, and where an uploaded one lands before it is restored.
 *
 * A named volume rather than the container's writable layer: these files are GB-scale, and an
 * overlay2 layer that big survives neither an image rebuild nor a sane disk-usage story. It also
 * means an interrupted download can simply be retried instead of re-running the export.
 */

/** Metadata sidecar written next to each `<id>.plmig`. */
export interface ArchiveRecord {
  id: string;
  filename: string;
  bytes: number;
  created_at: string;
  /** `export` — built here; `upload` — dropped in for an import. */
  origin: 'export' | 'upload';
  /** sha256 of the archive file, so a download can be checked on the far side. */
  sha256?: string;
  /** Present on exports: the source census carried inside the archive. */
  fingerprint?: Fingerprint;
  /** Set once `preflight` has streamed the whole file successfully. */
  verified_at?: string;
  note?: string;
}

function root(): string {
  return env.BACKUP_DIR;
}

function uploadsDir(): string {
  return path.join(root(), 'uploads');
}

export function archivePath(id: string): string {
  return path.join(root(), `${id}${ARCHIVE_EXT}`);
}

function sidecarPath(id: string): string {
  return path.join(root(), `${id}.json`);
}

export function uploadPath(id: string): string {
  return path.join(uploadsDir(), `${id}.part`);
}

/** Reject anything that isn't one of our generated ids, so no path can escape the volume. */
export function isValidId(id: string): boolean {
  return /^[a-z0-9]{8,40}$/.test(id);
}

export function newId(): string {
  return crypto.randomBytes(12).toString('hex');
}

export async function ensureDirs(): Promise<void> {
  await fs.promises.mkdir(root(), { recursive: true });
  await fs.promises.mkdir(uploadsDir(), { recursive: true });
}

export async function writeRecord(rec: ArchiveRecord): Promise<void> {
  await fs.promises.writeFile(sidecarPath(rec.id), JSON.stringify(rec, null, 2));
}

export async function readRecord(id: string): Promise<ArchiveRecord | null> {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fs.promises.readFile(sidecarPath(id), 'utf8')) as ArchiveRecord;
  } catch {
    return null;
  }
}

/** Newest first. A sidecar whose archive has gone missing is skipped rather than listed as broken. */
export async function listArchives(): Promise<ArchiveRecord[]> {
  await ensureDirs();
  const entries = await fs.promises.readdir(root());
  const out: ArchiveRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const rec = await readRecord(name.slice(0, -5));
    if (!rec) continue;
    try {
      const stat = await fs.promises.stat(archivePath(rec.id));
      out.push({ ...rec, bytes: stat.size });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function deleteArchive(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  let removed = false;
  for (const p of [archivePath(id), sidecarPath(id)]) {
    try {
      await fs.promises.unlink(p);
      removed = true;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/**
 * Keep the most recent `keep` archives. Retention is deliberate rather than unbounded: each file is
 * a full copy of the instance, so three of them on a small VPS is already a real fraction of the disk.
 */
export async function pruneArchives(keep = 3): Promise<number> {
  const all = await listArchives();
  let pruned = 0;
  for (const rec of all.slice(keep)) {
    if (await deleteArchive(rec.id)) pruned++;
  }
  if (pruned > 0) log.info({ pruned, keep }, 'pruned old instance archives');
  return pruned;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Free bytes on the backup volume — surfaced before an export so it fails early, not at 90%. */
export async function freeBytes(): Promise<number | null> {
  try {
    const stat = await fs.promises.statfs(root());
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/** Adopt an uploaded `.part` as a real archive once its header parses. */
export async function promoteUpload(uploadId: string, note?: string): Promise<ArchiveRecord> {
  const src = uploadPath(uploadId);
  const id = newId();
  const dest = archivePath(id);
  await fs.promises.rename(src, dest);

  let header;
  try {
    header = (await readArchiveHeader(dest)).header;
  } catch (err) {
    await fs.promises.unlink(dest).catch(() => undefined);
    throw err;
  }

  const stat = await fs.promises.stat(dest);
  const rec: ArchiveRecord = {
    id,
    filename: `${id}${ARCHIVE_EXT}`,
    bytes: stat.size,
    created_at: new Date().toISOString(),
    origin: 'upload',
    note: note ?? header.label,
  };
  await writeRecord(rec);
  log.info({ id, bytes: stat.size }, 'uploaded instance archive accepted');
  return rec;
}
