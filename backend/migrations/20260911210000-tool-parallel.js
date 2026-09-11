/**
 * Concurrent execution of one batch of tool calls.
 *
 * The model already emits independent calls together; the runner used to execute them strictly in
 * sequence, so a batch cost the sum of its calls. Two settings turn that into a real overlap:
 *
 * - `tool_parallel_enabled: true` — on for existing instances, not just new ones. Only calls whose
 *   tool declares itself parallel-safe ever overlap (reads, never writes), and the tool messages
 *   are still appended in emission order, so no prompt the model reads back changes shape.
 * - `tool_parallel_max: 4` — how many may be in flight at once; `0` would mean unlimited.
 */
module.exports = {
  async up(db) {
    await db.collection('settings').updateOne(
      { key: 'global' },
      { $set: { tool_parallel_enabled: true, tool_parallel_max: 4 } },
      { upsert: true },
    );
  },

  async down(db) {
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $unset: { tool_parallel_enabled: '', tool_parallel_max: '' } });
  },
};
