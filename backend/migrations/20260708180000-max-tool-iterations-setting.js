// Fleet default for the per-turn tool-round ceiling. Adds `max_tool_iterations` to the settings
// singleton. Previously this was a hardcoded constant (20) in AgentRunner; it now lives in Settings
// so operators can tune it without redeploying, while each agent may still override it with its own
// `max_tool_iterations`. Default 50.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany(
        { max_tool_iterations: { $exists: false } },
        { $set: { max_tool_iterations: 50 } },
      );
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { max_tool_iterations: '' } });
  },
};
