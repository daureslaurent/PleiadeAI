// Supports the all-in-one Android topology: the emulator runs inside the agent's own container
// rather than on a separate device host (see ANDROID_TOOL_PLAN.md).
//
//   images.android_emulator_avd  name of an AVD baked into the image, launched on demand by
//                                androidEmulatorScript ('' = the device lives elsewhere)
//   isolations.kvm               expose the host's /dev/kvm to this profile's containers
//                                (`docker create --device`), which the emulator needs to be usable
//
// Both default to off, so existing images/profiles are unaffected.

module.exports = {
  async up(db) {
    await db
      .collection('images')
      .updateMany({ android_emulator_avd: { $exists: false } }, { $set: { android_emulator_avd: '' } });
    await db.collection('isolations').updateMany({ kvm: { $exists: false } }, { $set: { kvm: false } });
  },

  async down(db) {
    await db.collection('images').updateMany({}, { $unset: { android_emulator_avd: '' } });
    await db.collection('isolations').updateMany({}, { $unset: { kvm: '' } });
  },
};
