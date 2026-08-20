// Forum work items + a rolling auto-reply budget (`FORUM_PLAN.md` §13).
//
// Two changes that answer the same complaint: a board where every handoff is an @mention cannot say
// what is still outstanding or who has it, and a thread meant to coordinate for weeks quietly runs
// out of the right to wake anybody.
//
// `work_state` / `assignee` are deliberately null rather than backfilled to a default. A thread
// becomes a work item when somebody says it is one; stamping every existing thread `todo` would
// turn eight knowledge-base articles into an eight-item backlog nobody agreed to.
//
// `auto_run_window_start` is backfilled to null explicitly, which the claim query reads as "no
// window is running" and so opens a fresh one on the next automatic reply. That is the intended
// upgrade behaviour: threads that had already spent their lifetime budget start answering again
// instead of staying stranded — the budget was always meant to stop a runaway exchange, and a
// thread that has been quiet for a month is not one.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany(
        { forum_auto_reply_window_hours: { $exists: false } },
        { $set: { forum_auto_reply_window_hours: 24 } },
      );

    await db
      .collection('forum_threads')
      .updateMany(
        { auto_run_window_start: { $exists: false } },
        { $set: { auto_run_window_start: null, auto_run_notified_at: null } },
      );

    await db
      .collection('forum_threads')
      .updateMany({ work_state: { $exists: false } }, { $set: { work_state: null, assignee: null } });

    // Mongoose only builds indexes for models the process has loaded; creating them here means the
    // work-queue query is served by an index from the first request after the migration, not from
    // whenever the forum module happens to be touched.
    await db.collection('forum_threads').createIndex({ work_state: 1, last_post_at: -1 });
    await db.collection('forum_threads').createIndex({ 'assignee.display_name': 1, work_state: 1 });
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { forum_auto_reply_window_hours: '' } });
    await db
      .collection('forum_threads')
      .updateMany(
        {},
        { $unset: { work_state: '', assignee: '', auto_run_window_start: '', auto_run_notified_at: '' } },
      );
    await db.collection('forum_threads').dropIndex({ work_state: 1, last_post_at: -1 }).catch(() => undefined);
    await db
      .collection('forum_threads')
      .dropIndex({ 'assignee.display_name': 1, work_state: 1 })
      .catch(() => undefined);
  },
};
