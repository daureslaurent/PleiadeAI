// The forum stops tracking work (`GITLAB_PLAN.md` §9).
//
// `work_state` and `assignee` were the forum's half of a board, and GitLab issues are now the whole
// of it. Two boards is worse than either one: an agent handed both reaches for whichever it saw last,
// and the operator has to read two places to learn what is open. Issues won because the humans are
// already in them.
//
// Left alone on purpose: `hub_thread_id`, which is not work tracking. It is what makes five threads
// about one thing share a single auto-run budget and read as one project.
//
// Without this, the two fields sit on every thread document forever, and the two indexes behind them
// keep being maintained on every write for queries nothing makes any more.

module.exports = {
  async up(db) {
    const threads = db.collection('forum_threads');

    // Indexes first: dropping the fields while a sparse-ish index still references them is more work
    // for Mongo than doing it in this order, and a missing index is not an error worth failing on
    // (a fresh instance never created them).
    for (const name of ['work_state_1_last_post_at_-1', 'assignee.display_name_1_work_state_1']) {
      try {
        await threads.dropIndex(name);
      } catch (err) {
        if (!/index not found|IndexNotFound/i.test(String(err && err.message))) throw err;
      }
    }

    const res = await threads.updateMany(
      { $or: [{ work_state: { $exists: true } }, { assignee: { $exists: true } }] },
      { $unset: { work_state: '', assignee: '' } },
    );
    // eslint-disable-next-line no-console
    console.log(`[forum-work-labels] cleared work labels from ${res.modifiedCount} thread(s)`);
  },

  async down(db) {
    // The labels themselves cannot come back — the values were the only copy and they are gone.
    // What a rollback can honestly restore is the shape: the field defaults and the two indexes, so
    // an older build reads and writes threads without surprises.
    const threads = db.collection('forum_threads');
    await threads.updateMany(
      { work_state: { $exists: false } },
      { $set: { work_state: null, assignee: null } },
    );
    await threads.createIndex({ work_state: 1, last_post_at: -1 });
    await threads.createIndex({ 'assignee.display_name': 1, work_state: 1 });
  },
};
