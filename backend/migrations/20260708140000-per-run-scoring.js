/**
 * Per-agent-run scoring: the Conversation Quality Scorer's unit becomes the agent-run (each
 * `ask_agent` sub-agent scored on its own), not the whole turn.
 *  - index `run_id` on the llama archive.
 *  - re-key `conversation_scores` on `run_id` (was `turn_id`). Old turn-keyed scores are dropped —
 *    they are regenerable via "Score all"; the run-level model supersedes them.
 */
module.exports = {
  async up(db) {
    await db.collection('llama_calls_archive').createIndex({ run_id: 1 });

    // Old scores were unique on turn_id and lack run_id — clear and re-key on run_id.
    await db.collection('conversation_scores').deleteMany({});
    await db.collection('conversation_scores').dropIndex('turn_id_1').catch(() => undefined);
    await db.collection('conversation_scores').createIndex({ run_id: 1 }, { unique: true });
    await db.collection('conversation_scores').createIndex({ turn_id: 1 });
  },

  async down(db) {
    await db.collection('llama_calls_archive').dropIndex({ run_id: 1 }).catch(() => undefined);
    await db.collection('conversation_scores').dropIndex('run_id_1').catch(() => undefined);
    await db.collection('conversation_scores').deleteMany({});
  },
};
