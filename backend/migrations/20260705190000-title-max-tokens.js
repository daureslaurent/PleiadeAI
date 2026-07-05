// Configurable token budget for session-title generation. Adds `title_max_tokens` to the settings
// singleton. The previous hardcoded 32 was too low for reasoning models: the `<think>` block alone
// exhausted the budget, so the title came back empty or as truncated reasoning. Default 256 leaves
// room for the reasoning block plus the title afterward.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany(
        { title_max_tokens: { $exists: false } },
        { $set: { title_max_tokens: 256 } },
      );
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { title_max_tokens: '' } });
  },
};
