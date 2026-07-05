// `title_auto` on sessions: true while the title is machine-generated (the auto-titler may refine
// it as the conversation grows); a manual rename flips it to false and freezes the title.
// Backfill predates the field: existing sessions are treated as auto-titled so they keep improving.

module.exports = {
  async up(db) {
    await db
      .collection('sessions')
      .updateMany({ title_auto: { $exists: false } }, { $set: { title_auto: true } });
  },

  async down(db) {
    await db.collection('sessions').updateMany({}, { $unset: { title_auto: '' } });
  },
};
