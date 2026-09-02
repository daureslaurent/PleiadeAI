// Per-model inference modes (`MODES_PLAN.md`). `endpoints.modes[]` holds operator-defined sampling
// presets and prompt snippets, each tagged with the model it belongs to; `sessions.mode_ids[]` holds
// the ones the operator switched on for a conversation. Both start empty: an install that never
// defines a mode behaves exactly as it did before.

module.exports = {
  async up(db) {
    await db.collection('endpoints').updateMany({ modes: { $exists: false } }, { $set: { modes: [] } });
    await db.collection('sessions').updateMany({ mode_ids: { $exists: false } }, { $set: { mode_ids: [] } });
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { modes: '' } });
    await db.collection('sessions').updateMany({}, { $unset: { mode_ids: '' } });
  },
};
