// Add the `subagent` role flag to agents (opencode-style primary/subagent split).
// Backfills existing documents with `true` so every current agent stays visible in the `annuaire`
// (the prior behaviour). Operators then flip their top-level orchestrators to `false`.

module.exports = {
  async up(db) {
    await db.collection('agents').updateMany(
      { subagent: { $exists: false } },
      { $set: { subagent: true } },
    );
  },

  async down(db) {
    await db.collection('agents').updateMany({}, { $unset: { subagent: '' } });
  },
};
