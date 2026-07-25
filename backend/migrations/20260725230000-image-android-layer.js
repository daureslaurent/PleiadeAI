// Adds the Android-control flags to `images` (see ANDROID_TOOL_PLAN.md):
//   - android            declares the image carries the Android layer (`adb`); agents on an isolation
//                        profile referencing it are auto-granted the android_* tools
//   - android_adb_serial the adb serial those tools talk to ('' → the loopback default)
//
// Existing images default to `false` / '', so nothing changes until the operator ticks the toggle.

module.exports = {
  async up(db) {
    await db
      .collection('images')
      .updateMany({ android: { $exists: false } }, { $set: { android: false, android_adb_serial: '' } });
  },

  async down(db) {
    await db.collection('images').updateMany({}, { $unset: { android: '', android_adb_serial: '' } });
  },
};
