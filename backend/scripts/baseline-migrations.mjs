#!/usr/bin/env node
/**
 * baseline-migrations — adopt migrate-mongo on a database whose schema was built WITHOUT ever running
 * migrations (the historical state of these deployments: Mongoose created the collections/indexes and
 * the `changelog` collection is empty).
 *
 * Running the full historical migration chain against such a DB fails: some change-sets try to create
 * an index/collection Mongoose already made (e.g. a unique `turn_id_1` that collides with an existing
 * non-unique one), which aborts boot. Baselining records every migration file that isn't already in
 * the `changelog` as *applied* — WITHOUT executing it — so the boot-time `migrate-mongo up` (see
 * src/db/migrate.ts) skips them and only runs genuinely new change-sets going forward.
 *
 * Run ONCE per existing deployment, before/at the first boot on the new code:
 *   npm run migrate:baseline
 *
 * Safe + reversible: it only inserts `changelog` records, never touches application data. A truly
 * fresh DB (no app collections) does NOT need this — let `migrate-mongo up` build it from scratch.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MongoClient } = require('mongodb');
// Single source of truth for URL + database name (same config the CLI + boot migrator use).
const config = require('../migrate-mongo-config.js');

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const ext = config.migrationFileExtension ?? '.js';
const changelogName = config.changelogCollectionName ?? 'changelog';

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(ext))
  .sort();

const client = new MongoClient(config.mongodb.url);
await client.connect();
try {
  const db = client.db(config.mongodb.databaseName);
  const changelog = db.collection(changelogName);
  const already = new Set((await changelog.find({}, { projection: { fileName: 1 } }).toArray()).map((d) => d.fileName));

  const pending = files.filter((f) => !already.has(f));
  if (pending.length === 0) {
    console.log(`[baseline] changelog already covers all ${files.length} migration(s) — nothing to do.`);
  } else {
    const now = new Date();
    await changelog.insertMany(pending.map((fileName) => ({ fileName, appliedAt: now })));
    console.log(`[baseline] marked ${pending.length} migration(s) as applied (of ${files.length} total):`);
    for (const f of pending) console.log(`  - ${f}`);
    console.log('[baseline] future `migrate-mongo up` (incl. the boot migrator) will now run only NEW migrations.');
  }
} finally {
  await client.close();
}
