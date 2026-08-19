// Adds the forum file registry and post attachments (`FORUM_PLAN.md` §10): agents and the operator
// can hang files — a chart, a log bundle, a rendered clip, a spec PDF — off a thread or a reply.
//
// Files are a collection of their own rather than an array embedded on a post, so one artifact can be
// attached by many posts without being stored twice and survives the post that introduced it. Bytes
// live in the `forum_files` GridFS bucket, which Mongo creates on first write.
//
// The text index has to be *replaced*, not extended: MongoDB allows exactly one text index per
// collection, so making attachment filenames keyword-searchable means dropping `body_text` and
// creating the compound one. The drop is guarded — on a fresh database it simply isn't there.

const COLLECTION = 'forum_files';

module.exports = {
  async up(db) {
    const existing = await db.listCollections({ name: COLLECTION }).toArray();
    if (!existing.length) await db.createCollection(COLLECTION);

    await db.collection(COLLECTION).createIndex({ sha256: 1 });
    await db.collection(COLLECTION).createIndex({ deleted: 1, created_at: -1 });

    // Backfill so every post has the field the reader code expects, rather than relying on Mongoose
    // defaults that only apply to documents written from now on.
    await db
      .collection('forum_posts')
      .updateMany({ attachments: { $exists: false } }, { $set: { attachments: [], attachment_names: '' } });

    await db.collection('forum_posts').createIndex({ attachments: 1 });

    const indexes = await db.collection('forum_posts').indexes();
    if (indexes.some((i) => i.name === 'body_text')) {
      await db.collection('forum_posts').dropIndex('body_text');
    }
    await db
      .collection('forum_posts')
      .createIndex({ body: 'text', attachment_names: 'text' }, { weights: { body: 10, attachment_names: 5 } });
  },

  async down(db) {
    const indexes = await db.collection('forum_posts').indexes();
    for (const name of ['body_text_attachment_names_text', 'attachments_1']) {
      if (indexes.some((i) => i.name === name)) await db.collection('forum_posts').dropIndex(name);
    }
    await db.collection('forum_posts').createIndex({ body: 'text' });
    await db
      .collection('forum_posts')
      .updateMany({}, { $unset: { attachments: '', attachment_names: '' } });

    // The registry docs are dropped; the GridFS buckets are left alone, since blowing away bytes is
    // not something a schema rollback should do silently.
    const existing = await db.listCollections({ name: COLLECTION }).toArray();
    if (existing.length) await db.collection(COLLECTION).drop();
  },
};
