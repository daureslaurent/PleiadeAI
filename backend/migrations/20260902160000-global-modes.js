// Global inference modes (`MODES_PLAN.md`): prompt snippets offered in every conversation whatever
// endpoint and model it runs on, stored on the settings singleton. Prompt-only by construction — a
// sampler tuned for one model says nothing about the next one. Starts empty, so nothing changes for
// an install that defines none.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany({ global_modes: { $exists: false } }, { $set: { global_modes: [] } });
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { global_modes: '' } });
  },
};
