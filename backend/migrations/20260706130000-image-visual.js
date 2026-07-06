// Add the `visual` flag to the `images` collection. A visual image's Dockerfile is expected to
// include the visual layer (Xvfb + x11vnc + xdotool/scrot/pyautogui); agents on a profile that
// references it are auto-granted the `visual_screenshot`/`visual_act` core tools. Existing images
// default to non-visual.

module.exports = {
  async up(db) {
    await db.collection('images').updateMany(
      { visual: { $exists: false } },
      { $set: { visual: false } },
    );
  },

  async down(db) {
    await db.collection('images').updateMany({}, { $unset: { visual: '' } });
  },
};
