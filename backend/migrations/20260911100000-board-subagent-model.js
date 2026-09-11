/**
 * Subagent mode and per-endpoint parallelism (`BOARD_SUBAGENT_MODEL_PLAN.md`).
 *
 * Three fields, all defaulting to today's behaviour:
 *
 * - `endpoints.parallel_slots: 1` — the strict per-URL serialization the inference gate has always
 *   enforced. It only changes once an operator declares what their server was actually launched
 *   with, which this migration deliberately does not guess: over-declaring makes llama.cpp queue
 *   requests internally, where the app can neither see nor meter them.
 * - `settings.forum_subagent_endpoint_id` / `_model: ''` — off, so every board turn keeps running
 *   on its agent's own model until the operator picks one.
 * - `forum_plans.subagent_endpoint_id` / `_model: ''` — every existing project inherits the fleet.
 */
module.exports = {
  async up(db) {
    await db
      .collection('endpoints')
      .updateMany({ parallel_slots: { $exists: false } }, { $set: { parallel_slots: 1 } });

    await db.collection('settings').updateOne(
      { key: 'global' },
      { $set: { forum_subagent_endpoint_id: '', forum_subagent_model: '' } },
      { upsert: true },
    );

    await db
      .collection('forum_plans')
      .updateMany(
        { subagent_endpoint_id: { $exists: false } },
        { $set: { subagent_endpoint_id: '', subagent_model: '' } },
      );
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { parallel_slots: '' } });
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $unset: { forum_subagent_endpoint_id: '', forum_subagent_model: '' } });
    await db
      .collection('forum_plans')
      .updateMany({}, { $unset: { subagent_endpoint_id: '', subagent_model: '' } });
  },
};
