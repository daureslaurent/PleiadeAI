// Android agents (see ANDROID_PLAN.md). Adds the two fields that make an agent able to drive a
// phone, alongside the new `android_devices` collection (which needs no migration — Mongoose creates
// it and its unique `name` index on first write):
//
//   images.android           the image carries the Android layer (adb + socat + scrcpy-server)
//   agents.android_device_id the device this agent drives; null = not an Android agent
//
// Both default to the inert value, so every existing image and agent keeps its current behaviour
// until the operator opts one in.

module.exports = {
  async up(db) {
    await db
      .collection('images')
      .updateMany({ android: { $exists: false } }, { $set: { android: false } });
    await db
      .collection('agents')
      .updateMany({ android_device_id: { $exists: false } }, { $set: { android_device_id: null } });
  },

  async down(db) {
    await db.collection('images').updateMany({}, { $unset: { android: '' } });
    await db.collection('agents').updateMany({}, { $unset: { android_device_id: '' } });
    // The registry itself is operator data, not schema — dropping it on a rollback would destroy
    // configuration the operator typed in. Left in place deliberately.
  },
};
