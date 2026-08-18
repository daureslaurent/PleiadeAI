// Auto agent mode (AUTO_AGENT_PLAN.md): the `auto_loops` collection plus the `agents.auto_mode` flag
// that unlocks the composer's Loop panel.
//
// `auto_mode` is backfilled to `false` rather than left absent because the flag is what the Workspace
// reads to decide whether to offer the loop at all — an absent field would render as "off" anyway,
// but a queryable one lets "which agents can self-drive?" be a plain find instead of a scan.
//
// `session_id` is unique: a loop *is* a session (that's what makes every turn it produces an ordinary
// session resource, and what lets the existing `session:subscribe` stream it with no new plumbing),
// so two loops on one conversation would be two schedulers fighting over the same history.

module.exports = {
  async up(db) {
    await db.createCollection('auto_loops').catch(() => undefined);
    await db.collection('auto_loops').createIndex({ session_id: 1 }, { unique: true });
    // The boot-time resume sweep queries by status; so does the "is anything still looping?" badge.
    await db.collection('auto_loops').createIndex({ status: 1, next_run_at: 1 });
    await db.collection('auto_loops').createIndex({ agent_id: 1 });

    await db
      .collection('agents')
      .updateMany({ auto_mode: { $exists: false } }, { $set: { auto_mode: false } });
  },

  async down(db) {
    await db.collection('auto_loops').drop().catch(() => undefined);
    await db.collection('agents').updateMany({}, { $unset: { auto_mode: '' } });
  },
};
