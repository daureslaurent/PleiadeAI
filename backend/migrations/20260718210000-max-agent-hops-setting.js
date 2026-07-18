// Moves the `ask_agent` delegation-depth ceiling from the `MAX_AGENT_HOPS` env var into runtime
// settings, so it is editable from Settings → Inference without a redeploy.
//
// Seeded to `null` rather than a number: `settingsService.get()` falls back to the env var when the
// field is null, so an existing deployment keeps whatever ceiling it is running with until the
// operator sets one explicitly in the UI.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateOne({ key: 'global', max_agent_hops: { $exists: false } }, { $set: { max_agent_hops: null } });
  },

  async down(db) {
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: { max_agent_hops: '' } });
  },
};
