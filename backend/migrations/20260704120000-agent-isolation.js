// Add the `isolation` subdocument to agents (per-agent Docker execution isolation).
// Backfills existing documents with the disabled default so reads are consistent. The default
// Dockerfile is left empty here and lazily populated by the Mongoose model default on first save,
// keeping this migration free of the template string.

module.exports = {
  async up(db) {
    await db.collection('agents').updateMany(
      { isolation: { $exists: false } },
      {
        $set: {
          isolation: {
            enabled: false,
            dockerfile: '',
            image_status: 'none',
            image_built_at: null,
            last_build_error: null,
            cpus: '1',
            memory: '1g',
            network: 'bridge',
            idle_timeout_ms: 1800000,
          },
        },
      },
    );
  },

  async down(db) {
    await db.collection('agents').updateMany({}, { $unset: { isolation: '' } });
  },
};
