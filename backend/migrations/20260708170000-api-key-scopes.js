// Add per-key write `scopes` to `api_keys`. A key stays read-only unless a scope grants it write
// access to a route family (see `API_KEY_SCOPES` / `auth.ts`); the first scope is `agents:write`.
//
// Existing keys predate the field: backfill them to an explicit empty array so they remain
// read-only (matching the Mongoose default) rather than relying on `undefined` at read time.

module.exports = {
  async up(db) {
    await db
      .collection('api_keys')
      .updateMany({ scopes: { $exists: false } }, { $set: { scopes: [] } });
  },

  async down(db) {
    await db.collection('api_keys').updateMany({}, { $unset: { scopes: '' } });
  },
};
