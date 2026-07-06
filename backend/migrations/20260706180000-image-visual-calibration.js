// Visual-desktop click calibration: each image gains a `visual_calibration` subdocument (null until
// measured) holding the per-axis affine that corrects the vision model's coordinate bias so clicks
// land on target. Purely additive — initialise existing images to null.

module.exports = {
  async up(db) {
    await db.collection('images').updateMany(
      { visual_calibration: { $exists: false } },
      { $set: { visual_calibration: null } },
    );
  },

  async down(db) {
    await db.collection('images').updateMany({}, { $unset: { visual_calibration: '' } });
  },
};
