// Read-only API keys (Settings → API Keys). Each document is one external credential that may call
// GET/HEAD on the REST API but never mutate, open a websocket, or manage keys.
//
// Only `prefix` (the public lookup handle) and `key_hash` = sha256(full key) are stored — the
// plaintext is shown once at creation and is unrecoverable. `prefix` is the verification lookup, so
// it carries a unique index.

module.exports = {
  async up(db) {
    await db.createCollection('api_keys').catch(() => {});
    await db.collection('api_keys').createIndex({ prefix: 1 }, { unique: true });
    // The Settings list renders newest-first.
    await db.collection('api_keys').createIndex({ created_at: -1 });
  },

  async down(db) {
    await db.collection('api_keys').drop().catch(() => {});
  },
};
