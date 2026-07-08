/**
 * Conversation Quality Scorer support:
 *  - index `turn_id` on the llama archive so a turn's calls group efficiently.
 *  - `conversation_scores` collection: one score per scored turn (keyed by turn_id).
 */
module.exports = {
  async up(db) {
    await db.collection('llama_calls_archive').createIndex({ turn_id: 1 });

    const scores = await db.listCollections({ name: 'conversation_scores' }).toArray();
    if (scores.length === 0) await db.createCollection('conversation_scores');
    // One score per turn; re-scoring upserts on this key.
    await db.collection('conversation_scores').createIndex({ turn_id: 1 }, { unique: true });
    await db.collection('conversation_scores').createIndex({ session_id: 1 });
    await db.collection('conversation_scores').createIndex({ tag: 1 });
    await db.collection('conversation_scores').createIndex({ score: -1 });
    await db.collection('conversation_scores').createIndex({ created_at: -1 });
  },

  async down(db) {
    await db.collection('llama_calls_archive').dropIndex({ turn_id: 1 }).catch(() => undefined);
    await db.collection('conversation_scores').drop().catch(() => undefined);
  },
};
