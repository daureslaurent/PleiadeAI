// Refactor: per-agent embedded isolation → shared Isolation profiles.
// Creates the `isolations` collection (unique name index) and switches agents from an embedded
// `isolation` subdocument to an `isolation_id` reference + `isolation_volume_mode`. Greenfield:
// any embedded config is dropped (no agents had it in real use yet).

module.exports = {
  async up(db) {
    await db.createCollection('isolations').catch(() => {});
    await db.collection('isolations').createIndex({ name: 1 }, { unique: true });

    await db.collection('agents').updateMany(
      {},
      {
        $unset: { isolation: '' },
        $set: { isolation_id: null, isolation_volume_mode: 'individual' },
      },
    );
  },

  async down(db) {
    await db
      .collection('agents')
      .updateMany({}, { $unset: { isolation_id: '', isolation_volume_mode: '' } });
    await db.collection('isolations').drop().catch(() => {});
  },
};
