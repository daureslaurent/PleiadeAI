// Memory "souvenirs" (docs/memory-souvenirs.md). Adds the distillation knobs to the settings
// singleton. Previously every turn was dumped into Qdrant verbatim as `"User: …\nAgent: …"`; with
// distillation on, the agent's own model rewrites the turn into 0..N standalone memories (usually
// zero) before anything is stored. On by default — the old behaviour is not worth preserving.
//
// NOTE: legacy `source: 'auto_turn'` points already in Qdrant are NOT touched here (Mongo migrations
// can't reach Qdrant). They are wiped by the operator from the Memory Vault; until then the reader
// tolerates them (normalizePayload defaults them to a low-importance episode).

module.exports = {
  async up(db) {
    await db.collection('settings').updateMany(
      { memory_distill_enabled: { $exists: false } },
      { $set: { memory_distill_enabled: true, memory_max_tokens: 800 } },
    );
  },

  async down(db) {
    await db
      .collection('settings')
      .updateMany({}, { $unset: { memory_distill_enabled: '', memory_max_tokens: '' } });
  },
};
