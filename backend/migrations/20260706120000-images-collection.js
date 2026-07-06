// Decouple Docker images from isolation profiles. Images become a first-class `images` collection
// (own Dockerfile + build options + build lifecycle); isolation profiles reference one via a new
// `image_id` field and keep only the runtime policy. Fresh start: existing profiles are NOT
// auto-migrated to an image — the operator picks one on the Isolation page. Their now-unused
// `dockerfile`/`image_status` fields are left in place for backward-compat and simply ignored.

module.exports = {
  async up(db) {
    // Create the collection + unique name index (mirrors the profile/skill name constraint).
    const names = await db.listCollections({ name: 'images' }).toArray();
    if (names.length === 0) await db.createCollection('images');
    await db.collection('images').createIndex({ name: 1 }, { unique: true });

    // Every profile gains an unassigned image reference until the operator picks one.
    await db.collection('isolations').updateMany(
      { image_id: { $exists: false } },
      { $set: { image_id: null } },
    );
  },

  async down(db) {
    await db.collection('isolations').updateMany({}, { $unset: { image_id: '' } });
    await db.collection('images').drop().catch(() => undefined);
  },
};
