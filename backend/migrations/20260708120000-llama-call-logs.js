/**
 * LLM Debug page (raw llama call capture). Two tiers:
 *  - `llama_calls_debug`   — capped ring buffer (last 50) the page reads by default.
 *  - `llama_calls_archive` — uncapped durable copy (full images + raw chunks); future fine-tuning source.
 */
module.exports = {
  async up(db) {
    const debug = await db.listCollections({ name: 'llama_calls_debug' }).toArray();
    if (debug.length === 0) {
      // Capped: newest 50 docs, within a 32 MiB byte ceiling (both bounds enforced by Mongo).
      await db.createCollection('llama_calls_debug', { capped: true, size: 33554432, max: 50 });
    }
    await db.collection('llama_calls_debug').createIndex({ created_at: -1 });
    await db.collection('llama_calls_debug').createIndex({ call_id: 1 });

    const archive = await db.listCollections({ name: 'llama_calls_archive' }).toArray();
    if (archive.length === 0) await db.createCollection('llama_calls_archive');
    await db.collection('llama_calls_archive').createIndex({ created_at: -1 });
    await db.collection('llama_calls_archive').createIndex({ call_id: 1 });
    await db.collection('llama_calls_archive').createIndex({ session_id: 1 });
    await db.collection('llama_calls_archive').createIndex({ source: 1 });
    await db.collection('llama_calls_archive').createIndex({ model: 1 });
  },

  async down(db) {
    await db.collection('llama_calls_debug').drop().catch(() => undefined);
    await db.collection('llama_calls_archive').drop().catch(() => undefined);
  },
};
