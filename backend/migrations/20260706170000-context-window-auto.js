// Auto context-max detection controls: the global `context_window_auto` default (on) and each
// endpoint's `context_window_mode` (`inherit` = follow the global default). Auto uses each server's
// probed real n_ctx (`endpoint.model_contexts`); manual keeps the typed `context_window` numbers.

module.exports = {
  async up(db) {
    await db.collection('settings').updateMany(
      { context_window_auto: { $exists: false } },
      { $set: { context_window_auto: true } },
    );
    await db.collection('endpoints').updateMany(
      { context_window_mode: { $exists: false } },
      { $set: { context_window_mode: 'inherit' } },
    );
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { context_window_auto: '' } });
    await db.collection('endpoints').updateMany({}, { $unset: { context_window_mode: '' } });
  },
};
