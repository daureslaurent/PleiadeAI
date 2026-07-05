// Host self-update bridge. The backend runs inside a container, but the update
// itself (`update_run.sh`: git pull + `docker compose build` then `up -d`) must
// run on the *host*, because it rebuilds and swaps this very container — a
// process can't reliably kill its own container and survive to bring it back.
//
// We decouple the two: this module never runs docker or git. It only drops a
// small trigger file into a bind-mounted directory. A host-side systemd watcher
// (installed via tools/updater/install-updater.sh) sees the file appear and runs
// update_run.sh. Because the watcher lives on the host, `docker compose down`
// can't kill it.
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';

// Bind-mounted in docker-compose as ./.update -> /app/.update. Configured via env.
const TRIGGER_DIR = env.UPDATE_TRIGGER_DIR;
const TRIGGER_FILE = path.join(TRIGGER_DIR, 'trigger');
// Separate trigger for a read-only update *check* (git fetch + status.json write),
// distinct from the destructive update trigger above.
const CHECK_TRIGGER_FILE = path.join(TRIGGER_DIR, 'check');
// Where the host watcher (check_run.sh) writes the comparison result.
const STATUS_FILE = path.join(TRIGGER_DIR, 'status.json');
// Where the systemd update/check services append their stdout+stderr
// (StandardOutput=append:.../update.log). Bind-mounted, so the backend can tail
// it to stream host-side progress into the "Updating…" overlay.
const LOG_FILE = path.join(TRIGGER_DIR, 'update.log');

export interface UpdateReadiness {
  /** True when the trigger directory is mounted and writable. */
  ready: boolean;
  /** Human-readable reason when not ready (for a Settings-page hint). */
  reason?: string;
}

// Whether dropping a trigger would actually reach the host. A false here almost
// always means the ./.update bind mount is missing from docker-compose, so the
// button would silently do nothing — we surface that to the UI instead.
export async function getUpdateReadiness(): Promise<UpdateReadiness> {
  try {
    await fs.access(TRIGGER_DIR, FS.W_OK);
    return { ready: true };
  } catch {
    return { ready: false, reason: `trigger directory ${TRIGGER_DIR} is not mounted or not writable` };
  }
}

// Signal the host watcher to update. The file content is informational only —
// the watcher triggers on the file's existence and removes it before running.
export async function requestUpdate(meta: { by?: string } = {}): Promise<void> {
  await fs.mkdir(TRIGGER_DIR, { recursive: true });
  const payload = JSON.stringify({ requestedAt: new Date().toISOString(), by: meta.by ?? 'web' });
  await fs.writeFile(TRIGGER_FILE, payload + '\n', 'utf8');
}

// Signal the host watcher to run a read-only update check: `git fetch origin master`
// then write the HEAD..origin/master comparison to status.json. Like requestUpdate,
// the file's existence is the signal; the watcher removes it before running.
export async function requestCheck(meta: { by?: string } = {}): Promise<void> {
  await fs.mkdir(TRIGGER_DIR, { recursive: true });
  const payload = JSON.stringify({ requestedAt: new Date().toISOString(), by: meta.by ?? 'auto' });
  await fs.writeFile(CHECK_TRIGGER_FILE, payload + '\n', 'utf8');
}

/** Current byte size of the host update log (0 when it doesn't exist yet). */
export async function getUpdateLogSize(): Promise<number> {
  try {
    return (await fs.stat(LOG_FILE)).size;
  } catch {
    return 0;
  }
}

/** A slice of the host update log, read from `since` to the current end. */
export interface UpdateLogChunk {
  /** New text appended since the requested offset (empty when nothing new). */
  text: string;
  /** Byte offset to pass as `since` on the next poll. */
  offset: number;
  /** Current total log size, so the client can detect truncation/rotation. */
  size: number;
}

// Read the host update log from byte `since` to the end. The log is append-only
// across runs, so callers pass the offset captured when their update started to
// see only this run's output. A single read is capped (MAX_CHUNK) to bound the
// payload; if the file shrank below `since` (rotated/cleared) we restart from 0.
const MAX_CHUNK = 256 * 1024;
export async function readUpdateLog(since = 0): Promise<UpdateLogChunk> {
  let size = 0;
  try {
    size = (await fs.stat(LOG_FILE)).size;
  } catch {
    return { text: '', offset: 0, size: 0 };
  }
  let start = Number.isFinite(since) && since >= 0 && since <= size ? since : 0;
  if (start >= size) return { text: '', offset: size, size };
  // On the first read of a long pre-existing log, only return the tail.
  if (size - start > MAX_CHUNK) start = size - MAX_CHUNK;
  const fh = await fs.open(LOG_FILE, 'r');
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return { text: buf.toString('utf8', 0, bytesRead), offset: size, size };
  } finally {
    await fh.close();
  }
}

/** One commit that `origin/master` is ahead of the deployed checkout. */
export interface UpdateCommit {
  sha: string;
  shortSha: string;
  /** ISO-8601 author date. */
  date: string;
  author: string;
  subject: string;
  /** Full commit body (everything after the subject line). Empty when none. */
  body: string;
}

/** Result of the host-side `git fetch` comparison, written to status.json. */
export interface UpdateStatus {
  /** ISO-8601 timestamp of when the host ran the check. */
  checkedAt: string;
  currentSha: string;
  currentShortSha: string;
  remoteSha: string;
  remoteShortSha: string;
  branch: string;
  /** Number of commits origin/master is ahead of the deployed checkout (0 = up to date). */
  behindBy: number;
  /** App version string of the deployed checkout (from version.json). Empty when unknown. */
  currentVersion: string;
  /** App version string origin/master would deploy. Empty when unknown. */
  remoteVersion: string;
  /** The commits ahead, newest first. Empty when up to date or on error. */
  commits: UpdateCommit[];
  /** Set when the host check itself failed (e.g. git fetch could not reach the remote). */
  error?: string;
}

// The host writes free-text fields (author, subject) base64-encoded so arbitrary
// commit text can never break the JSON; decode them back here.
function decodeB64(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// Read + parse the host-written status.json. Returns null when the file is absent
// (no check has run yet) or unparseable — callers treat that as "unknown".
export async function readUpdateStatus(): Promise<UpdateStatus | null> {
  let raw: string;
  try {
    raw = await fs.readFile(STATUS_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const rawCommits = Array.isArray(o.commits) ? o.commits : [];
    const commits: UpdateCommit[] = rawCommits
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({
        sha: String(c.sha ?? ''),
        shortSha: String(c.shortSha ?? ''),
        date: String(c.date ?? ''),
        author: decodeB64(c.authorB64),
        subject: decodeB64(c.subjectB64),
        body: decodeB64(c.bodyB64),
      }));
    const behindBy = Number.isFinite(Number(o.behindBy)) ? Math.max(0, Math.floor(Number(o.behindBy))) : 0;
    return {
      checkedAt: String(o.checkedAt ?? ''),
      currentSha: String(o.currentSha ?? ''),
      currentShortSha: String(o.currentShortSha ?? ''),
      remoteSha: String(o.remoteSha ?? ''),
      remoteShortSha: String(o.remoteShortSha ?? ''),
      branch: String(o.branch ?? 'master'),
      behindBy,
      currentVersion: String(o.currentVersion ?? ''),
      remoteVersion: String(o.remoteVersion ?? ''),
      commits,
      error: o.error ? String(o.error) : undefined,
    };
  } catch {
    return null;
  }
}
