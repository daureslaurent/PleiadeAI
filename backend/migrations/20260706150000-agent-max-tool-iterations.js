// Add the optional `max_tool_iterations` knob to the `agents` collection: the per-agent ceiling on
// tool round-trips within a single turn (see AgentRunner's tool loop). `null` means "use the global
// default"; agents that drive long multi-step flows (notably visual/desktop agents) can raise it so
// they don't stall mid-task. Existing agents default to null (global default).

module.exports = {
  async up(db) {
    await db.collection('agents').updateMany(
      { max_tool_iterations: { $exists: false } },
      { $set: { max_tool_iterations: null } },
    );
  },

  async down(db) {
    await db.collection('agents').updateMany({}, { $unset: { max_tool_iterations: '' } });
  },
};
