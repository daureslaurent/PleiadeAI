// Add the operator-chosen visual identity fields to agents: `color` (HSL hue, null = unset → the
// deterministic name-hash color) and `icon` (curated lucide key, '' = unset → the initial letter).
// Existing agents keep their auto-derived identity until an operator overrides them.

module.exports = {
  async up(db) {
    await db
      .collection('agents')
      .updateMany(
        { color: { $exists: false } },
        { $set: { color: null, icon: '' } },
      );
  },

  async down(db) {
    await db
      .collection('agents')
      .updateMany({}, { $unset: { color: '', icon: '' } });
  },
};
