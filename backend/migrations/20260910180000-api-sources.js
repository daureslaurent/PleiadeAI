/**
 * Configured HTTP APIs (`API_TOOL_PLAN.md`).
 *
 * Purely additive: a new empty collection with a unique index on `name`, because that name is the
 * namespace an agent calls (`weather.forecast`) and two APIs answering to `weather` would make the
 * operation id ambiguous. Nothing existing changes, and until the operator adds an entry `api_man`
 * reports an empty catalogue — the tools are inert rather than broken on a fresh deploy.
 */
module.exports = {
  async up(db) {
    const names = await db.listCollections({ name: 'api_sources' }).toArray();
    if (!names.length) await db.createCollection('api_sources');
    await db.collection('api_sources').createIndex({ name: 1 }, { unique: true });
    await db.collection('api_sources').createIndex({ enabled: 1 });
  },

  async down(db) {
    // The credentials live only here, so dropping is the honest inverse of creating.
    await db.collection('api_sources').drop().catch(() => {});
  },
};
