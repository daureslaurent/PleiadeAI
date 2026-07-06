// Add the `model_contexts` map to the `endpoints` collection: per-model real context size (n_ctx),
// probed from the server at model discovery (`/props` runtime n_ctx, else `/v1/models`
// `meta.n_ctx_train`). It's the honest denominator for the chat context meter and takes precedence
// over the manual `context_window`. Existing endpoints start empty and fill on the next discovery.

module.exports = {
  async up(db) {
    await db.collection('endpoints').updateMany(
      { model_contexts: { $exists: false } },
      { $set: { model_contexts: {} } },
    );
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { model_contexts: '' } });
  },
};
