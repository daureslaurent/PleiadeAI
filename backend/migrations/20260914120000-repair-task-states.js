// A manager's `board patch_task` could write any string as a task's state, since the update went
// through `findByIdAndUpdate` with no enum check. `in_progress` (the forum `work_state` word) reached
// prod: the scheduler never dispatches it and the board page crashed drawing it.
//
// `patch` now refuses an unknown state; this repairs rows written before it did. Any unknown state
// becomes `todo` — the manager forcing a state on an open task meant "work on this again", and `todo`
// is the state the scheduler re-dispatches from.

const TASK_STATES = ['todo', 'doing', 'review', 'blocked', 'done', 'cancelled'];

module.exports = {
  async up(db) {
    await db
      .collection('forum_tasks')
      .updateMany(
        { state: { $nin: TASK_STATES } },
        { $set: { state: 'todo', 'dispatch.session_id': null, 'dispatch.kind': null, updated_at: new Date() } },
      );
  },

  // The original strings are gone and were never valid; nothing to restore.
  async down() {},
};
