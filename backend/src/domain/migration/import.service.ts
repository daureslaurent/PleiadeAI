import mongoose from 'mongoose';
import { createLogger } from '../../config/logger';
import { qdrantService } from '../memory/qdrant.service';
import { readArchive, collectEntry, type EntryHeader } from './archive';
import { fieldKeyFor, INSTANCE_TYPE, type Manifest } from './export.service';
import { diffEnv, activeEncKeyFingerprint, type EnvDiffRow, type EnvSnapshot } from './env-snapshot';
import { hasSecrets, rewrapForImport, newRewrapStats, type RewrapStats } from './secrets';
import { takeFingerprint, diffFingerprints, listCollections, type Fingerprint, type FingerprintDiff } from './fingerprint';
import { archivePath, readRecord, writeRecord } from './storage';
import { enterMaintenance } from './maintenance-mode';
import type { ProgressSink } from './job';

const log = createLogger('migration-import');

const { BSON } = mongoose.mongo;

/** Documents per `insertMany`. Large enough to amortise the round trip, small enough to stay under 16 MB. */
const INSERT_BATCH = 500;
/** Qdrant points per upsert call. */
const QDRANT_BATCH = 256;

export interface PreflightReport {
  archive_id: string;
  manifest: Manifest;
  /** The census the source took of itself. */
  source_fingerprint: Fingerprint;
  /** What this instance currently holds — i.e. what the restore would destroy. */
  target_fingerprint: Fingerprint;
  env: { present: boolean; rows: EnvDiffRow[] };
  /** Credential fields the *source* could not decrypt; they will arrive unusable. */
  secret_warnings: string[];
  /** Key fingerprints, so an operator can see the credentials are being re-wrapped, not copied. */
  enc_keys: { source: string; target: string };
  /** Non-fatal observations (version drift, missing Qdrant, …). */
  warnings: string[];
  /** The whole archive streamed and parsed without error. */
  verified: boolean;
}

/**
 * Stream the archive end to end, parsing every entry and discarding the payloads.
 *
 * This is the step that makes a bad archive a clean refusal rather than a half-restored instance
 * (spec §6): a wrong passphrase, a truncated upload or a corrupt frame all surface here, before
 * anything has been dropped. It costs one full read of a multi-GB file, which is the cheapest
 * insurance available against the one failure mode that has no undo.
 */
export async function runPreflight(
  archiveId: string,
  passphrase: string,
  progress: ProgressSink,
): Promise<PreflightReport> {
  const file = archivePath(archiveId);
  progress.phase('Reading the archive');

  let manifest: Manifest | null = null;
  let env: EnvSnapshot | null = null;
  let sourceFingerprint: Fingerprint | null = null;
  let secretWarnings: string[] = [];
  let bytes = 0;

  await readArchive(file, passphrase, async (header: EntryHeader, next) => {
    if (header.kind === 'manifest') {
      manifest = JSON.parse((await collectEntry(next)).toString('utf8')) as Manifest;
      progress.phase(`Verifying ${manifest.collections.length} collections`);
      progress.total(
        manifest.collections.reduce((n, c) => n + c.documents, 0) +
          manifest.qdrant.reduce((n, c) => n + c.points, 0),
      );
      return;
    }
    if (header.kind === 'env') {
      env = JSON.parse((await collectEntry(next)).toString('utf8')) as EnvSnapshot;
      return;
    }
    if (header.kind === 'fingerprint') {
      const tail = JSON.parse((await collectEntry(next)).toString('utf8')) as {
        fingerprint: Fingerprint;
        secrets: RewrapStats;
      };
      sourceFingerprint = tail.fingerprint;
      secretWarnings = tail.secrets?.warnings ?? [];
      return;
    }
    // A data entry: read it through to prove it decrypts and inflates, then let it go.
    if (header.name) progress.phase(`Verifying ${header.name}`);
    for (;;) {
      const chunk = await next();
      if (chunk === null) break;
      bytes += chunk.length;
    }
  });

  if (!manifest) throw new Error('archive has no manifest — it is not a PleiadesAI instance archive');
  const mf = manifest as Manifest;
  if (mf.type !== INSTANCE_TYPE) throw new Error(`unexpected archive type "${mf.type}"`);
  if (!sourceFingerprint) {
    // The census is written last, so its absence means the stream ended early despite every frame
    // authenticating — i.e. the file was cut on a frame boundary.
    throw new Error('archive is incomplete (its trailing census is missing) — re-download or re-upload it');
  }

  const warnings: string[] = [];
  const targetFingerprint = await takeFingerprint();
  const targetKeyFp = activeEncKeyFingerprint();
  if (mf.source.enc_key_fingerprint === targetKeyFp) {
    warnings.push('Source and target share an encryption key; credentials are re-wrapped regardless.');
  }
  if (mf.options.excludeInferenceLogs) warnings.push('This archive was exported without inference logs.');
  if (mf.options.excludeMedia) warnings.push('This archive was exported without generated media (GridFS).');
  if (mf.qdrant.length === 0) warnings.push('This archive carries no vector memory.');

  const targetDocs = targetFingerprint.mongo.total_documents;
  if (targetDocs > 0) {
    warnings.push(
      `This instance currently holds ${targetDocs} documents across ${Object.keys(targetFingerprint.mongo.collections).length} collections. All of it will be destroyed.`,
    );
  }

  const record = await readRecord(archiveId);
  if (record) await writeRecord({ ...record, verified_at: new Date().toISOString() });

  log.info({ archiveId, bytes, collections: mf.collections.length }, 'archive preflight passed');

  return {
    archive_id: archiveId,
    manifest: mf,
    source_fingerprint: sourceFingerprint,
    target_fingerprint: targetFingerprint,
    env: { present: env !== null, rows: env ? diffEnv(env) : [] },
    secret_warnings: secretWarnings,
    enc_keys: { source: mf.source.enc_key_fingerprint, target: targetKeyFp },
    warnings,
    verified: true,
  };
}

export interface RestoreReport {
  collections_restored: number;
  documents_restored: number;
  qdrant_collections_restored: number;
  qdrant_points_restored: number;
  secrets: RewrapStats;
  /** Census comparison against what the archive said it carried. */
  verification: FingerprintDiff;
  warnings: string[];
  /** Whether the backend asked Docker to restart it; false means restart by hand. */
  restart_requested: boolean;
}

/**
 * Replace this instance with the archive's.
 *
 * Not transactional, and deliberately not pretending to be (spec §6): a two-phase restore into a
 * shadow database would double the disk a multi-GB archive needs, on the very box least likely to
 * have it. What stands in for atomicity is {@link runPreflight} — the archive is proven readable end
 * to end *before* the first collection is dropped, so the realistic failure left is the database
 * going away underneath us, which no amount of staging would survive either. On failure the instance
 * stays in maintenance mode with the error, rather than quietly serving a half-restored fleet.
 */
export async function runRestore(
  archiveId: string,
  passphrase: string,
  progress: ProgressSink,
): Promise<RestoreReport> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongo is not connected');
  const file = archivePath(archiveId);

  progress.phase('Stopping background work');
  await enterMaintenance('an instance restore is in progress');

  const fieldKey = await fieldKeyFor(passphrase);
  const secrets = newRewrapStats();
  const warnings: string[] = [];

  let manifest: Manifest | null = null;
  let collectionsRestored = 0;
  let documentsRestored = 0;
  let qdrantRestored = 0;
  let qdrantPoints = 0;
  let expected: Fingerprint | null = null;

  // Everything the target holds that the archive does *not* mention must go too, or a collection
  // from this instance's own history would survive the move and quietly outlive the source.
  const targetCollections = new Set(await listCollections());

  await readArchive(file, passphrase, async (header, next) => {
    if (header.kind === 'manifest') {
      manifest = JSON.parse((await collectEntry(next)).toString('utf8')) as Manifest;
      progress.total(
        manifest.collections.reduce((n, c) => n + c.documents, 0) +
          manifest.qdrant.reduce((n, c) => n + c.points, 0),
      );
      return;
    }
    if (header.kind === 'fingerprint') {
      const tail = JSON.parse((await collectEntry(next)).toString('utf8')) as { fingerprint: Fingerprint };
      expected = tail.fingerprint;
      return;
    }
    if (header.kind === 'env') {
      // Displayed at preflight, never applied — the backend does not own the host's .env.
      await collectEntry(next);
      return;
    }

    if (header.kind === 'collection' && header.name) {
      const name = header.name;
      progress.phase(`Restoring ${name}`);
      // Drop rather than `deleteMany({})`: on a GridFS chunks collection with millions of rows the
      // difference is minutes against milliseconds, and the indexes are replayed from the manifest
      // afterwards anyway.
      await db.collection(name).drop().catch(() => undefined);
      targetCollections.delete(name);

      const carriesSecrets = hasSecrets(name);
      let batch: Record<string, unknown>[] = [];
      let tail: Buffer = Buffer.alloc(0);

      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        // `ordered: false` so one poisoned document cannot abandon the rest of the collection.
        await db.collection(name).insertMany(batch, { ordered: false });
        documentsRestored += batch.length;
        progress.advance(batch.length);
        batch = [];
      };

      for (;;) {
        const chunk = await next();
        if (chunk === null) break;
        const buf = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
        let offset = 0;
        // BSON documents are self-length-prefixed, so a chunk boundary can fall anywhere inside one.
        for (;;) {
          if (buf.length - offset < 4) break;
          const size = buf.readInt32LE(offset);
          if (size <= 0 || buf.length - offset < size) break;
          const doc = BSON.deserialize(buf.subarray(offset, offset + size)) as Record<string, unknown>;
          if (carriesSecrets) rewrapForImport(name, doc, fieldKey, secrets);
          batch.push(doc);
          offset += size;
          if (batch.length >= INSERT_BATCH) await flush();
        }
        tail = buf.subarray(offset);
      }
      await flush();
      if (tail.length > 0) warnings.push(`${name}: ${tail.length} trailing bytes could not be parsed`);
      collectionsRestored++;
      return;
    }

    if (header.kind === 'qdrant' && header.name) {
      const name = header.name;
      progress.phase(`Restoring vector memory ${name}`);
      try {
        await qdrantService.recreateCollection(name, (header.params ?? {}) as Record<string, unknown>);
      } catch (err) {
        warnings.push(`qdrant ${name}: could not be recreated (${(err as Error).message}) — memory not restored`);
        return;
      }
      let tail: Buffer = Buffer.alloc(0);
      for (;;) {
        const chunk = await next();
        if (chunk === null) break;
        const buf = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
        let offset = 0;
        for (;;) {
          if (buf.length - offset < 4) break;
          const size = buf.readInt32LE(offset);
          if (size <= 0 || buf.length - offset < size) break;
          const page = BSON.deserialize(buf.subarray(offset, offset + size)) as {
            points: Array<Record<string, unknown>>;
          };
          for (let i = 0; i < page.points.length; i += QDRANT_BATCH) {
            const slice = page.points.slice(i, i + QDRANT_BATCH);
            await qdrantService.restorePoints(name, slice);
            qdrantPoints += slice.length;
            progress.advance(slice.length);
          }
          offset += size;
        }
        tail = buf.subarray(offset);
      }
      qdrantRestored++;
      return;
    }
  });

  if (!manifest) throw new Error('archive has no manifest');
  const mf = manifest as Manifest;

  // Anything left over belonged to this instance alone.
  for (const leftover of targetCollections) {
    progress.phase(`Dropping ${leftover} (not present in the archive)`);
    await db.collection(leftover).drop().catch(() => undefined);
    warnings.push(`${leftover} existed here but not in the archive — dropped.`);
  }

  // Qdrant collections the archive doesn't know about, same reasoning.
  try {
    const carried = new Set(mf.qdrant.map((q) => q.name));
    for (const name of await qdrantService.listCollections()) {
      if (!carried.has(name)) {
        await qdrantService.dropCollection(name);
        warnings.push(`qdrant ${name} existed here but not in the archive — dropped.`);
      }
    }
  } catch (err) {
    warnings.push(`could not reconcile leftover Qdrant collections: ${(err as Error).message}`);
  }

  progress.phase('Recreating indexes');
  await restoreIndexes(mf, warnings);

  progress.phase('Releasing scheduler locks');
  await releaseAgendaLocks(warnings);

  progress.phase('Verifying');
  const actual = await takeFingerprint();
  const verification = expected
    ? diffFingerprints(adjustExpected(expected, mf), actual)
    : { matches: false, differences: ['the archive carried no census to verify against'] };

  if (secrets.unreadable > 0) {
    warnings.push(`${secrets.unreadable} credential field(s) arrived unusable and were cleared — re-enter them.`);
    warnings.push(...secrets.warnings);
  }

  log.warn(
    { archiveId, collections: collectionsRestored, documents: documentsRestored, matches: verification.matches },
    'instance restore finished',
  );

  return {
    collections_restored: collectionsRestored,
    documents_restored: documentsRestored,
    qdrant_collections_restored: qdrantRestored,
    qdrant_points_restored: qdrantPoints,
    secrets,
    verification,
    warnings,
    restart_requested: false,
  };
}

/**
 * The source's census covers collections this archive may have been told to leave behind, so the
 * excluded ones are removed from what we expect to find rather than reported as losses.
 */
function adjustExpected(expected: Fingerprint, manifest: Manifest): Fingerprint {
  const carried = new Set(manifest.collections.map((c) => c.name));
  const collections: Record<string, number> = {};
  for (const [name, n] of Object.entries(expected.mongo.collections)) {
    if (carried.has(name)) collections[name] = n;
  }
  const gridfs_bytes: Record<string, number> = {};
  for (const [bucket, n] of Object.entries(expected.mongo.gridfs_bytes)) {
    if (carried.has(`${bucket}.files`)) gridfs_bytes[bucket] = n;
  }
  return {
    ...expected,
    mongo: {
      collections,
      gridfs_bytes,
      total_documents: Object.values(collections).reduce((a, b) => a + b, 0),
    },
  };
}

/**
 * Replay the source's index definitions.
 *
 * Mongoose's `autoIndex` would build most of these on the next boot anyway, but not all: an index
 * created by a migration rather than by a schema has no `autoIndex` to rebuild it, and a restore
 * that relied on the next boot would serve unindexed collation-sensitive queries in the meantime.
 */
async function restoreIndexes(manifest: Manifest, warnings: string[]): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  for (const [collection, specs] of Object.entries(manifest.indexes ?? {})) {
    for (const spec of specs) {
      const name = String(spec.name ?? '');
      if (name === '_id_' || !spec.key) continue; // `_id_` is created with the collection
      const { key, v, ns, ...options } = spec as Record<string, unknown>;
      void v;
      void ns;
      try {
        await db.collection(collection).createIndex(key as Record<string, 1 | -1>, options);
      } catch (err) {
        warnings.push(`index ${collection}.${name} could not be recreated: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Clear Agenda's job locks.
 *
 * A job the *source* instance had locked when the export ran arrives still marked as locked, and
 * Agenda will not pick up a locked job whose owner no longer exists — every cron on the new box
 * would silently never fire again. Unlocking is what makes the fleet's autonomy survive the move.
 */
async function releaseAgendaLocks(warnings: string[]): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  try {
    const res = await db
      .collection('agenda_jobs')
      .updateMany({ lockedAt: { $ne: null } }, { $set: { lockedAt: null, lastModifiedBy: null } });
    if (res.modifiedCount > 0) log.info({ unlocked: res.modifiedCount }, 'released inherited agenda locks');
  } catch (err) {
    warnings.push(`could not release scheduler locks: ${(err as Error).message}`);
  }
}
