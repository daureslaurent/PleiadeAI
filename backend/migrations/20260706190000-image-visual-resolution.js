// Visual desktop resolution: each image gains `visual_width` / `visual_height` (null → the boot
// default 1280×800). Injected as PLEIADE_VISUAL_GEOMETRY when the desktop boots. Purely additive.

module.exports = {
  async up(db) {
    await db.collection('images').updateMany(
      { visual_width: { $exists: false } },
      { $set: { visual_width: null, visual_height: null } },
    );
  },

  async down(db) {
    await db.collection('images').updateMany({}, { $unset: { visual_width: '', visual_height: '' } });
  },
};
