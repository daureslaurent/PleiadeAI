// migrate-mongo configuration. Reads the same MONGO_URI the app uses so migrations
// and runtime always target one database. Migration change-sets live in ./migrations.
const url = process.env.MONGO_URI || 'mongodb://localhost:27017/pleiade';

// Derive the database name from the connection string (falls back to "pleiade").
function databaseName(uri) {
  try {
    const afterHost = uri.split('/').pop() || '';
    const name = afterHost.split('?')[0];
    return name || 'pleiade';
  } catch {
    return 'pleiade';
  }
}

module.exports = {
  mongodb: {
    url,
    databaseName: databaseName(url),
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'changelog',
  migrationFileExtension: '.js',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
