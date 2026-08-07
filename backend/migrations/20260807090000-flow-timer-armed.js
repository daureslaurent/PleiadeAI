// Adds `flows.timer_armed` — whether a flow's Time trigger is currently ticking (STREAMING_PLAN.md §4).
//
// Backfilled to `false` rather than left absent so `FlowTimerScheduler.restore()` can query the flag
// directly at boot: a live streaming flow must come back on air after a restart, and a missing field
// on old documents would make "was this armed?" indistinguishable from "no".

module.exports = {
  async up(db) {
    await db
      .collection('flows')
      .updateMany({ timer_armed: { $exists: false } }, { $set: { timer_armed: false } });
  },

  async down(db) {
    await db.collection('flows').updateMany({}, { $unset: { timer_armed: '' } });
  },
};
