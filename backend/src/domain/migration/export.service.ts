import fs from 'node:fs';
import mongoose from 'mongoose';
import { ArchiveWriter, deriveKey } from './archive';
import { createLogger } from '../../config/logger';
import { qdrantService } from '../memory/qdrant.service';
import { takeFingerprint, listCollections, gridfsBuckets, type Fingerprint } from './fingerprint';
import { takeEnvSnapshot, activeEncKeyFingerprint } from './env-snapshot';
import { hasSecrets, rewrapForExport, newRewrapStats, type RewrapStats } from './secrets';
import {
  archivePath,
  ensureDirs,
  newId,
  pruneArchives,
  sha256File,
  writeRecord,
  type ArchiveRecord,
} from './storage';
import type { ProgressSink } from './job';

const log = createLogger('migration-export');

const { BSON } = mongoose.mongo;

/**
 * `BSON.serialize` hands back a `Uint8Array`; view it as a Buffer without copying the bytes.
 * At GridFS scale (255 KB per chunk document) a copy per document is real memory traffic.
 */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Flush the BSON accumulator at ~8 MB, which is well under gzip's appetite and far above per-doc cost. */
const WRITE_BUFFER_BYTES = 8 * 1024 * 1024;
/** Cursor page size. Small enough that a GridFS chunk collection (255 KB/doc) stays bounded. */
const CURSOR_BATCH = 200;

export interface ExportOptions {
  passphrase: string;
  /** Carry the `.env` snapshot, credentials included, for the import page to display. */
  includeEnv: boolean;
  /** Drop `llama_calls_archive` / `llama_calls_debug` — history, not state, and often most of the file. */
  excludeInferenceLogs: boolean;
  /** Drop the GridFS buckets holding generated media and uploads. */
  excludeMedia: boolean;
  label?: string;
}

/** What the archive says about itself, read during preflight before anything is touched. */
export interface Manifest {
  type: 'pleiades-instance';
  version: number;
  exported_at: string;
  /** Which app build produced it — a mismatch is a warning, not a refusal. */
  source: { app_version?: string; node: string; enc_key_fingerprint: string };
  options: { includeEnv: boolean; excludeInferenceLogs: boolean; excludeMedia: boolean };
  collections: Array<{ name: string; documents: number }>;
  qdrant: Array<{ name: string; points: number }>;
  /** Indexes per collection, replayed on import so a fresh DB isn't left to Mongoose's autoIndex alone. */
  indexes: Record<string, Array<Record<string, unknown>>>;
}

export const MANIFEST_VERSION = 1;
export const INSTANCE_TYPE = 'pleiades-instance';

/** Collections skipped when the operator opts out of carrying inference history. */
const INFERENCE_LOG_COLLECTIONS = new Set(['llama_calls_archive', 'llama_calls_debug']);

function appVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../../../package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Which collections this export carries.
 *
 * Enumerated from the live database rather than from a hand-kept registry (spec §3): a release that
 * adds a collection is migrated without anyone remembering to add it here, which is the only way
 * "nothing must be missing" survives a schema that keeps moving.
 */
export async function plannedCollections(opts: Pick<ExportOptions, 'excludeInferenceLogs' | 'excludeMedia'>): Promise<string[]> {
  const all = await listCollections();
  const mediaBuckets = gridfsBuckets(all);
  return all.filter((name) => {
    if (opts.excludeInferenceLogs && INFERENCE_LOG_COLLECTIONS.has(name)) return false;
    if (opts.excludeMedia && mediaBuckets.some((b) => name === `${b}.files` || name === `${b}.chunks`)) {
      return false;
    }
    return true;
  });
}

/** Key used to re-wrap credential fields. Derived from the passphrase alone so import can match it. */
export function fieldKeyFor(passphrase: string): Promise<Buffer> {
  return deriveKey(passphrase, Buffer.from(INSTANCE_TYPE, 'utf8'));
}

/**
 * Build a `.plmig` archive of this whole instance.
 *
 * Documents are written as **raw BSON**, not Extended JSON: types round-trip exactly (`ObjectId`,
 * `Date`, `Binary`, `Long`, `Decimal128`) and GridFS chunks — 255 KB of binary each, and most of a
 * media-heavy instance — avoid base64's 33% inflation.
 *
 * Reads go through the **native driver**, never Mongoose: every credential field in this codebase is
 * `select: false`, so a Mongoose read would quietly omit exactly the rows that must not be lost.
 */
export async function runExport(opts: ExportOptions, progress: ProgressSink): Promise<ArchiveRecord> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongo is not connected');

  await ensureDirs();
  const id = newId();
  const file = archivePath(id);

  progress.phase('Taking a census of this instance');
  const fingerprint: Fingerprint = await takeFingerprint();
  const collections = await plannedCollections(opts);
  const qdrantNames = await qdrantService.listCollections().catch((err) => {
    log.warn({ err }, 'qdrant unreachable — exporting without vector memory');
    progress.warn('Qdrant was unreachable; vector memory is NOT in this archive.');
    return [] as string[];
  });

  const plannedDocs = collections.reduce((n, c) => n + (fingerprint.mongo.collections[c] ?? 0), 0);
  const plannedPoints = qdrantNames.reduce((n, c) => n + (fingerprint.qdrant.collections[c] ?? 0), 0);
  progress.total(plannedDocs + plannedPoints);

  const writer = await ArchiveWriter.create(file, opts.passphrase, opts.label);
  // The credential re-wrap needs a key the *import* side can reproduce before it has read the
  // archive's own salt, so it is derived from the passphrase under a fixed salt and diversified
  // again inside `secrets.ts`. Independent of the archive key, which `ArchiveWriter` salts randomly.
  const fieldKey = await fieldKeyFor(opts.passphrase);
  const secretStats: RewrapStats = newRewrapStats();

  try {
    const indexes: Record<string, Array<Record<string, unknown>>> = {};
    for (const name of collections) {
      try {
        indexes[name] = (await db.collection(name).listIndexes().toArray()) as Array<Record<string, unknown>>;
      } catch {
        indexes[name] = [];
      }
    }

    const manifest: Manifest = {
      type: INSTANCE_TYPE,
      version: MANIFEST_VERSION,
      exported_at: new Date().toISOString(),
      source: { app_version: appVersion(), node: process.version, enc_key_fingerprint: activeEncKeyFingerprint() },
      options: {
        includeEnv: opts.includeEnv,
        excludeInferenceLogs: opts.excludeInferenceLogs,
        excludeMedia: opts.excludeMedia,
      },
      collections: collections.map((name) => ({ name, documents: fingerprint.mongo.collections[name] ?? 0 })),
      qdrant: qdrantNames.map((name) => ({ name, points: fingerprint.qdrant.collections[name] ?? 0 })),
      indexes,
    };
    await writer.json({ kind: 'manifest' }, manifest);

    if (opts.includeEnv) {
      await writer.json({ kind: 'env' }, takeEnvSnapshot(true));
    }

    // --- Mongo ---
    for (const name of collections) {
      progress.phase(`Exporting ${name}`);
      const carriesSecrets = hasSecrets(name);
      let written = 0;

      await writer.entry({ kind: 'collection', name }, async (write) => {
        const cursor = db.collection(name).find({}, { batchSize: CURSOR_BATCH });
        let buffered: Buffer[] = [];
        let bufferedLen = 0;

        for await (const doc of cursor) {
          const record = doc as Record<string, unknown>;
          if (carriesSecrets) rewrapForExport(name, record, fieldKey, secretStats);
          const bson = asBuffer(BSON.serialize(record));
          buffered.push(bson);
          bufferedLen += bson.length;
          written++;
          if (bufferedLen >= WRITE_BUFFER_BYTES) {
            await write(Buffer.concat(buffered, bufferedLen));
            buffered = [];
            bufferedLen = 0;
            progress.advance(written);
            written = 0;
          }
        }
        if (bufferedLen > 0) await write(Buffer.concat(buffered, bufferedLen));
        progress.advance(written);
      });
    }

    // --- Qdrant ---
    for (const name of qdrantNames) {
      progress.phase(`Exporting vector memory ${name}`);
      const spec = await qdrantService.collectionSpec(name);
      if (!spec) continue;
      await writer.entry({ kind: 'qdrant', name, params: spec.params, points: spec.points }, async (write) => {
        await qdrantService.scrollPages(name, async (points) => {
          // One BSON document per page rather than per point: a 768-float vector is ~6 KB of BSON
          // doubles, and per-point framing would add a document header to every one of them.
          await write(asBuffer(BSON.serialize({ points })));
          progress.advance(points.length);
        });
      });
    }

    // The census and the secret tally are written last, so their presence proves the archive is whole.
    await writer.json(
      { kind: 'fingerprint' },
      { fingerprint, secrets: { ...secretStats }, manifest_version: MANIFEST_VERSION },
    );
    await writer.finish();
  } catch (err) {
    writer.destroy(err as Error);
    await fs.promises.unlink(file).catch(() => undefined);
    throw err;
  }

  progress.phase('Checksumming');
  const stat = await fs.promises.stat(file);
  const sha256 = await sha256File(file);

  const rec: ArchiveRecord = {
    id,
    filename: `pleiades-instance-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.plmig`,
    bytes: stat.size,
    created_at: new Date().toISOString(),
    origin: 'export',
    sha256,
    fingerprint,
    note: opts.label,
  };
  await writeRecord(rec);
  await pruneArchives();

  if (secretStats.unreadable > 0) {
    progress.warn(
      `${secretStats.unreadable} credential field(s) would not decrypt with this instance's key and were carried as-is.`,
    );
    for (const w of secretStats.warnings) progress.warn(w);
  }
  log.info(
    { id, bytes: stat.size, collections: collections.length, qdrant: qdrantNames.length, secrets: secretStats.rewrapped },
    'instance archive exported',
  );
  return rec;
}

