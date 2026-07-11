import { readdirSync } from 'node:fs';
import path from 'node:path';
import { config, database, up, type MigrateMongoConfig } from 'migrate-mongo';
import type { Collection } from 'mongodb';
import { createLogger } from '../config/logger';

const log = createLogger('migrate');

/**
 * Apply pending MongoDB migrations at boot, so a code deploy never runs ahead of the DB schema.
 *
 * Historically migrations were only applied by manually running `npm run migrate:up`; the app-update
 * flow (systemd watcher → `update_run.sh` → `docker compose up`) never did, so new code could silently
 * hit an un-migrated schema. Running this in the backend container — which already has `MONGO_URI` and
 * reaches Mongo over the compose network — closes that gap for every restart (app update, update
 * script, or an ordinary reboot).
 *
 * **Adoption of an existing un-migrated database.** These deployments built their schema via Mongoose
 * (`autoIndex`), never via migrations, so their `changelog` is empty *and* the collections already
 * exist. Blindly running the historical chain against them fails — a change-set tries to create an
 * index Mongoose already made under a conflicting definition (e.g. a unique `turn_id_1` vs an existing
 * non-unique one), which would crash-loop boot. So when we detect that state (empty changelog + app
 * collections already present) we **baseline**: record the current migrations as applied *without*
 * executing them (Mongoose already owns the equivalent schema; the data-backfill change-sets are
 * no-ops on already-current data). Only genuinely new migrations run on subsequent boots.
 *
 * A pristine DB (empty changelog + no app collections) runs the full chain normally. `migrate-mongo up`
 * is idempotent, so once the changelog is in sync this is a no-op.
 *
 * Throws on failure: boot is intentionally aborted (via `main().catch`) rather than serving traffic
 * against a half-migrated database — a crash-loop is visible; silent schema drift is not.
 */
export async function runMigrations(): Promise<void> {
  // migrate-mongo-config.js is plain CommonJS shared with the `migrate-mongo` CLI. Requiring it keeps
  // the connection/database-name logic in one place; the migrations dir is forced absolute below.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const baseConfig = require('../../migrate-mongo-config.js') as MigrateMongoConfig;
  // From dist/db/migrate.js → /app/migrations; from src/db/migrate.ts (dev) → backend/migrations.
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const ext = baseConfig.migrationFileExtension ?? '.js';
  const changelogName = baseConfig.changelogCollectionName ?? 'changelog';

  config.set({ ...baseConfig, migrationsDir });

  const { db, client } = await database.connect();
  try {
    const changelog = db.collection(changelogName);

    // First-ever run against this DB? Decide between building it from scratch and adopting it.
    if ((await changelog.estimatedDocumentCount()) === 0) {
      const appCollections = (await db.listCollections({}, { nameOnly: true }).toArray())
        .map((c) => c.name)
        .filter((name) => name !== changelogName && !name.startsWith('system.'));

      if (appCollections.length > 0) {
        const files = migrationFiles(migrationsDir, ext);
        await baseline(changelog, files);
        log.warn(
          { adopted: files.length, existingCollections: appCollections.length },
          'existing un-migrated database detected — baselined migrations (adopted Mongoose-built schema) ' +
            'instead of running the historical chain; only new migrations will run from now on',
        );
        return;
      }
    }

    const applied = await up(db, client);
    if (applied.length) log.info({ applied }, `applied ${applied.length} migration(s)`);
    else log.info('database schema up to date');
  } finally {
    await client.close();
  }
}

/** Sorted list of migration file names in `dir` (matches migrate-mongo's own ordering). */
function migrationFiles(dir: string, ext: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .sort();
}

/**
 * Record `files` as applied in the changelog without running them (migrate-mongo's changelog doc shape
 * is `{ fileName, appliedAt }`). Used to adopt an existing DB whose schema predates migrations.
 */
async function baseline(changelog: Collection, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const now = new Date();
  await changelog.insertMany(files.map((fileName) => ({ fileName, appliedAt: now })));
}
