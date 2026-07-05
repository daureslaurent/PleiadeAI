// Multi-endpoint inference. Creates the `endpoints` collection (unique name index) and seeds a
// single `default` endpoint from the existing global settings connection, so agents that don't
// pick an endpoint keep hitting the same server as before. Adds `endpoint_id`/`model` to agents
// (null/empty = use the default endpoint + global default model).

module.exports = {
  async up(db) {
    await db.createCollection('endpoints').catch(() => {});
    await db.collection('endpoints').createIndex({ name: 1 }, { unique: true });

    // Seed the default endpoint from the settings singleton (falling back to sensible blanks — the
    // runtime resolver still tolerates a missing/empty base_url via env). Only if none exists yet.
    const existing = await db.collection('endpoints').findOne({});
    if (!existing) {
      const settings = await db.collection('settings').findOne({ key: 'global' });
      await db.collection('endpoints').insertOne({
        name: 'default',
        base_url: settings?.llama_url ?? '',
        api_key: settings?.llama_api_key ?? 'sk-no-key-required',
        models: settings?.llama_model ? [settings.llama_model] : [],
        default_model: settings?.llama_model ?? '',
        models_updated_at: null,
        context_window: 0,
        is_default: true,
        created_at: new Date(),
        updated_at: new Date(),
      });
    }

    await db.collection('agents').updateMany(
      {},
      { $set: { endpoint_id: null, model: '' } },
    );
  },

  async down(db) {
    await db.collection('agents').updateMany({}, { $unset: { endpoint_id: '', model: '' } });
    await db.collection('endpoints').drop().catch(() => {});
  },
};
