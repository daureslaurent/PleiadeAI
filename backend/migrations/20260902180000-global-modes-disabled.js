// Built-in global modes (`MODES_PLAN.md`) are code-defined and composed into the settings on read,
// never stored — so "the operator switched this one off" cannot live on the mode. It lives here, as
// a list of built-in ids. Starts empty: every built-in is offered until one is switched off.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany({ global_modes_disabled: { $exists: false } }, { $set: { global_modes_disabled: [] } });
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { global_modes_disabled: '' } });
  },
};
