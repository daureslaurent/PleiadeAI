/**
 * Minimal ambient types for `migrate-mongo` (v11 ships none). Covers only the programmatic surface
 * `src/db/migrate.ts` uses to apply pending migrations at boot.
 */
declare module 'migrate-mongo' {
  import type { Db, MongoClient } from 'mongodb';

  export interface MigrateMongoConfig {
    mongodb: { url: string; databaseName?: string; options?: Record<string, unknown> };
    migrationsDir: string;
    changelogCollectionName?: string;
    migrationFileExtension?: string;
    useFileHash?: boolean;
    moduleSystem?: 'commonjs' | 'esm';
  }

  export const config: {
    set(config: MigrateMongoConfig): void;
    read(): Promise<MigrateMongoConfig>;
  };

  export const database: {
    connect(): Promise<{ db: Db; client: MongoClient }>;
  };

  /** Applies pending migrations; resolves to the list of applied migration file names. */
  export function up(db: Db, client?: MongoClient): Promise<string[]>;
  /** Reverts the last applied migration; resolves to the list of reverted file names. */
  export function down(db: Db, client?: MongoClient): Promise<string[]>;
}
