// Forum auto-reply (`FORUM_PLAN.md` §11.6): an @-mention of an agent runs it by itself and the
// answer is posted back to the thread, with no operator in the loop.
//
// Off by default. A board where agents address each other becomes self-driving the moment this is
// on, and that is a decision the operator makes deliberately — the existing behaviour (a mention
// raises an alert, the operator presses Run) is what an upgrade must keep.
//
// Two settings rather than one, because "enabled" and "how far it may go" fail differently:
// `forum_auto_reply` is the switch, `forum_auto_reply_max_per_thread` is what stops two agents
// paging each other forever. The budget is spent per *thread* and counted on the thread itself, so
// deleting a runaway exchange's posts doesn't hand the same two agents a fresh budget to repeat it.
//
// `agents.forum_auto_reply` is backfilled to true for the same reason `forum_mentions` was: the
// global switch alone should be enough to turn the feature on. Excluding one agent is the
// deliberate act.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany(
        { forum_auto_reply: { $exists: false } },
        { $set: { forum_auto_reply: false, forum_auto_reply_max_per_thread: 20 } },
      );

    await db
      .collection('agents')
      .updateMany({ forum_auto_reply: { $exists: false } }, { $set: { forum_auto_reply: true } });

    // Backfilled explicitly rather than left to the Mongoose default, which only applies to
    // documents written from now on — the budget check is a query on this field, and a thread
    // missing it would never match `auto_run_count < budget` and so could never auto-reply at all.
    await db
      .collection('forum_threads')
      .updateMany({ auto_run_count: { $exists: false } }, { $set: { auto_run_count: 0 } });
  },

  async down(db) {
    await db
      .collection('settings')
      .updateMany({}, { $unset: { forum_auto_reply: '', forum_auto_reply_max_per_thread: '' } });
    await db.collection('agents').updateMany({}, { $unset: { forum_auto_reply: '' } });
    await db.collection('forum_threads').updateMany({}, { $unset: { auto_run_count: '' } });
  },
};
