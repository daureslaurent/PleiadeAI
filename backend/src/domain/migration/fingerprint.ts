import mongoose from 'mongoose';
import { qdrantService } from '../memory/qdrant.service';

/**
 * A comparable census of everything this instance holds (spec §6, step 3).
 *
 * This is what turns "the import said OK" into "nothing is missing": the same function runs on the
 * source at export time, travels inside the archive, and runs again on the target after the restore.
 * Any row that failed to land shows up as a diff rather than as a surprise three weeks later.
 *
 * GridFS is measured in **bytes as well as rows** deliberately — a chunk document that arrived
 * truncated still counts as one row.
 */
export interface Fingerprint {
  taken_at: string;
  mongo: {
    /** Collection name → exact document count. */
    collections: Record<string, number>;
    /** GridFS bucket → total stored bytes, summed from each bucket's `.files` metadata. */
    gridfs_bytes: Record<string, number>;
    total_documents: number;
  };
  qdrant: {
    /** Collection name → exact point count. */
    collections: Record<string, number>;
    total_points: number;
  };
}

/** Collections that are Mongo's own bookkeeping, never ours. */
export function isSystemCollection(name: string): boolean {
  return name.startsWith('system.');
}

/** Every application collection in the database, sorted for a stable archive order. */
export async function listCollections(): Promise<string[]> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongo is not connected');
  const infos = await db.listCollections({}, { nameOnly: true }).toArray();
  return infos
    .map((c) => c.name)
    .filter((n) => !isSystemCollection(n))
    .sort();
}

/** GridFS buckets, derived from the `<bucket>.files` / `<bucket>.chunks` pairs that exist. */
export function gridfsBuckets(collections: string[]): string[] {
  const names = new Set(collections);
  return collections
    .filter((n) => n.endsWith('.files') && names.has(`${n.slice(0, -6)}.chunks`))
    .map((n) => n.slice(0, -6));
}

export async function takeFingerprint(): Promise<Fingerprint> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongo is not connected');

  const names = await listCollections();
  const collections: Record<string, number> = {};
  let total = 0;
  for (const name of names) {
    // Exact, not estimated: this number is evidence, and `estimatedDocumentCount` reads cached
    // metadata that can lag a bulk insert by seconds — exactly the window a post-restore check runs in.
    const n = await db.collection(name).countDocuments();
    collections[name] = n;
    total += n;
  }

  const gridfs_bytes: Record<string, number> = {};
  for (const bucket of gridfsBuckets(names)) {
    const [row] = await db
      .collection(`${bucket}.files`)
      .aggregate<{ bytes: number }>([{ $group: { _id: null, bytes: { $sum: '$length' } } }])
      .toArray();
    gridfs_bytes[bucket] = row?.bytes ?? 0;
  }

  const qcollections: Record<string, number> = {};
  let points = 0;
  try {
    for (const name of await qdrantService.listCollections()) {
      const spec = await qdrantService.collectionSpec(name);
      qcollections[name] = spec?.points ?? 0;
      points += spec?.points ?? 0;
    }
  } catch {
    // Qdrant being unreachable must not make the census unavailable — the Mongo half is still the
    // answer to most of the question, and the caller reports the gap rather than failing outright.
  }

  return {
    taken_at: new Date().toISOString(),
    mongo: { collections, gridfs_bytes, total_documents: total },
    qdrant: { collections: qcollections, total_points: points },
  };
}

export interface FingerprintDiff {
  matches: boolean;
  /** One line per discrepancy, ready to render. */
  differences: string[];
}

/** Compare the archive's census against the target's, after a restore. */
export function diffFingerprints(expected: Fingerprint, actual: Fingerprint): FingerprintDiff {
  const differences: string[] = [];

  const collNames = new Set([
    ...Object.keys(expected.mongo.collections),
    ...Object.keys(actual.mongo.collections),
  ]);
  for (const name of [...collNames].sort()) {
    const want = expected.mongo.collections[name] ?? 0;
    const got = actual.mongo.collections[name] ?? 0;
    if (want !== got) differences.push(`${name}: expected ${want} documents, found ${got}`);
  }

  for (const [bucket, want] of Object.entries(expected.mongo.gridfs_bytes)) {
    const got = actual.mongo.gridfs_bytes[bucket] ?? 0;
    if (want !== got) differences.push(`gridfs ${bucket}: expected ${want} bytes, found ${got}`);
  }

  const qNames = new Set([
    ...Object.keys(expected.qdrant.collections),
    ...Object.keys(actual.qdrant.collections),
  ]);
  for (const name of [...qNames].sort()) {
    const want = expected.qdrant.collections[name] ?? 0;
    const got = actual.qdrant.collections[name] ?? 0;
    if (want !== got) differences.push(`qdrant ${name}: expected ${want} points, found ${got}`);
  }

  return { matches: differences.length === 0, differences };
}

/**
 * Rough byte size of what an export would carry, for the "this will be about N GB" line.
 *
 * `storageSize` is what the collection occupies *compressed* on disk, which is the closest cheap
 * proxy for a gzipped archive — `dataSize` would overstate a media-heavy instance by the exact
 * factor WiredTiger already saved. Neither is exact, and the readout says so.
 */
export async function estimateArchiveBytes(collections: string[]): Promise<number> {
  const db = mongoose.connection.db;
  if (!db) return 0;
  let total = 0;
  for (const name of collections) {
    try {
      // `storageStats` is the option name; `$collStats` silently returns a document *without* the
      // requested section when given an unknown one, which reads back as a plausible zero.
      const [row] = await db
        .collection(name)
        .aggregate<{ storageStats?: { storageSize?: number } }>([{ $collStats: { storageStats: {} } }])
        .toArray();
      total += row?.storageStats?.storageSize ?? 0;
    } catch {
      // A collection that vanished between listing and measuring contributes nothing.
    }
  }
  return total;
}
