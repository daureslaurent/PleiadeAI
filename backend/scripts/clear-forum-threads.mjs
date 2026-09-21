#!/usr/bin/env node
/**
 * Clear the forum's threads, keeping its categories.
 *
 * Deletes every thread, post and mention, and cleans the references that would otherwise dangle:
 * the Qdrant search index (a vector whose post is gone still answers `forum search`), the inbox
 * notifications that point at deleted threads, and the `forum_thread_id` / `forum_mention_id` on
 * sessions started by a mention.
 *
 * **Sessions are kept.** A mention-run session is a real transcript of an agent's turn; only its
 * pointer back to the deleted thread is cleared, so the conversation survives as an ordinary one.
 * Same principle for **files**: `forum_files` is a registry deliberately built to outlive the post
 * that introduced it (`FORUM_PLAN.md` §10), it has its own page, and an agent's memory may cite a
 * file id. Pass `--files` to purge it and its GridFS bytes as well.
 *
 * Usage, from `backend/`:
 *   node scripts/clear-forum-threads.mjs --dry-run        # count what would go, change nothing
 *   node scripts/clear-forum-threads.mjs                  # threads, posts, mentions, index
 *   node scripts/clear-forum-threads.mjs --files          # …and the file registry + bytes
 *
 * Reads MONGO_URI and QDRANT_URL from the environment, falling back to `backend/.env`. Point those
 * at the instance you mean.
 *
 * **This is the development script.** A deployed instance cannot run it: the runtime image copies
 * only `dist`, `node_modules`, `migrations` and the migrate config (see `backend/Dockerfile`), so
 * `scripts/` is not in it and Mongo publishes no host port. On a deployed host use
 * `clear-forum-threads.mongo.js` instead, which needs nothing but the containers already running.
 *
 * There is no undo. Run `--dry-run` first.
 */

import { MongoClient, GridFSBucket } from 'mongodb';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const WITH_FILES = process.argv.includes('--files');

// The backend validates its env at boot and exits on anything missing, so a `.env` beside it is the
// one place both it and this script can agree on. Explicit environment wins, so running inside the
// container (where there is no .env file) uses the container's own settings.
function envFromDotenv() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '.env'), 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

const dotenv = envFromDotenv();
const MONGO_URI = process.env.MONGO_URI || dotenv.MONGO_URI;
const QDRANT_URL = process.env.QDRANT_URL || dotenv.QDRANT_URL;

if (!MONGO_URI) {
  console.error('MONGO_URI is not set (env or backend/.env). Refusing to guess.');
  process.exit(1);
}

/** Where the vectors live. Must match `forum-index.service.ts`. */
const QDRANT_COLLECTION = 'forum_index';
/** Must match the GridFS bucket in `forum-file.repository.ts`. */
const FILE_BUCKET = 'forum_files';

const client = new MongoClient(MONGO_URI);

try {
  await client.connect();
  const db = client.db();

  const categories = await db.collection('forum_categories').countDocuments({});
  const threads = await db.collection('forum_threads').countDocuments({});
  const posts = await db.collection('forum_posts').countDocuments({});
  const mentions = await db.collection('forum_mentions').countDocuments({});
  const files = await db.collection('forum_files').countDocuments({});
  const notifs = await db
    .collection('notifications')
    .countDocuments({ kind: { $in: ['forum_thread', 'forum_mention'] } });
  const sessions = await db
    .collection('sessions')
    .countDocuments({ $or: [{ forum_thread_id: { $ne: null } }, { forum_mention_id: { $ne: null } }] });

  let vectors = null;
  if (QDRANT_URL) {
    try {
      const res = await fetch(`${QDRANT_URL.replace(/\/$/, '')}/collections/${QDRANT_COLLECTION}`);
      if (res.ok) vectors = (await res.json())?.result?.points_count ?? null;
    } catch {
      vectors = null;
    }
  }

  console.log(`database        ${db.databaseName}`);
  console.log(`categories      ${categories}  (kept)`);
  console.log(`threads         ${threads}`);
  console.log(`posts           ${posts}`);
  console.log(`mentions        ${mentions}`);
  console.log(`search vectors  ${vectors === null ? 'unknown (Qdrant unreachable)' : vectors}`);
  console.log(`notifications   ${notifs}  (forum_thread / forum_mention)`);
  console.log(`sessions        ${sessions}  (kept; thread pointers cleared)`);
  console.log(`files           ${files}  ${WITH_FILES ? '(PURGED, with bytes)' : '(kept — pass --files to purge)'}`);

  if (DRY) {
    console.log('\n--dry-run: nothing was changed.');
    process.exit(0);
  }

  const del = async (name, filter = {}) => {
    const r = await db.collection(name).deleteMany(filter);
    console.log(`deleted ${String(r.deletedCount).padStart(6)}  ${name}`);
  };

  await del('forum_posts');
  await del('forum_threads');
  await del('forum_mentions');
  await del('notifications', { kind: { $in: ['forum_thread', 'forum_mention'] } });

  // Keep the transcript, drop the dangling pointer. `forum_chain_reset` goes too: it only ever
  // qualified a mention chain that no longer exists.
  const unset = await db
    .collection('sessions')
    .updateMany(
      { $or: [{ forum_thread_id: { $ne: null } }, { forum_mention_id: { $ne: null } }] },
      { $set: { forum_thread_id: null, forum_mention_id: null, forum_chain_reset: false } },
    );
  console.log(`cleared ${String(unset.modifiedCount).padStart(6)}  session forum pointers`);

  if (WITH_FILES) {
    // Drop the bytes through the bucket so both `.files` and `.chunks` stay consistent.
    const bucket = new GridFSBucket(db, { bucketName: FILE_BUCKET });
    let bytes = 0;
    for await (const f of bucket.find({})) {
      await bucket.delete(f._id).catch(() => undefined);
      bytes += 1;
    }
    console.log(`deleted ${String(bytes).padStart(6)}  GridFS file bodies`);
    await del('forum_files');
  }

  // The index is rebuilt by the backend as agents post again, so clearing it costs nothing but the
  // re-embedding of whatever gets written next. Leaving it is what would be wrong: a vector whose
  // post is deleted still comes back from `forum search`, as a result nobody can open.
  if (QDRANT_URL) {
    const url = `${QDRANT_URL.replace(/\/$/, '')}/collections/${QDRANT_COLLECTION}/points/delete?wait=true`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // An empty `must` matches every point: delete the collection's contents, keep its config so
      // the backend does not have to recreate it with the right vector size on next boot.
      body: JSON.stringify({ filter: { must: [] } }),
    });
    console.log(res.ok ? 'cleared         search index' : `WARNING: index not cleared (HTTP ${res.status})`);
  } else {
    console.log('WARNING: QDRANT_URL unset — search index NOT cleared; stale hits will persist.');
  }

  const left = await db.collection('forum_threads').countDocuments({});
  const keptCats = await db.collection('forum_categories').countDocuments({});
  console.log(`\ndone: ${keptCats} categories kept, ${left} threads remaining.`);
} finally {
  await client.close();
}
