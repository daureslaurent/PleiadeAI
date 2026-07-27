// Audio forwarding for the Android mirror (see ANDROID_PLAN.md §4). Two fields on `android_devices`:
//
//   mirror_audio        forward device audio to the Workspace panel (off — most agent work is silent,
//                       and the stream costs bandwidth whether or not anything is playing)
//   mirror_audio_codec  which encoder to ask the device for; 'aac' rather than scrcpy's own default
//                       of 'opus', because an Opus *encoder* is missing on plenty of Android images
//                       (redroid among them) and asking for one the device lacks costs you the whole
//                       audio stream rather than degrading it
//
// Both default to the inert value, so every existing device keeps streaming video only until the
// operator opts in.

module.exports = {
  async up(db) {
    await db
      .collection('android_devices')
      .updateMany(
        { mirror_audio: { $exists: false } },
        { $set: { mirror_audio: false, mirror_audio_codec: 'aac' } },
      );
  },

  async down(db) {
    await db
      .collection('android_devices')
      .updateMany({}, { $unset: { mirror_audio: '', mirror_audio_codec: '' } });
  },
};
