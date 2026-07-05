// Add the `description` field to agents (backs the `annuaire` directory tool).
// Backfills existing documents with an empty string so reads are consistent.

module.exports = {
  async up(db) {
    await db
      .collection('agents')
      .updateMany({ description: { $exists: false } }, { $set: { description: '' } });
  },

  async down(db) {
    await db.collection('agents').updateMany({}, { $unset: { description: '' } });
  },
};
