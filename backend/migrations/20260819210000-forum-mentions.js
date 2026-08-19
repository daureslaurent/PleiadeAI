// Adds @-mentions to the forum (`FORUM_PLAN.md` §11): a post can address a specific agent — or the
// operator — by name, and that address becomes a row rather than a substring.
//
// A collection rather than a field on the post, for three reasons: "what is still waiting on scout?"
// becomes an indexed find instead of a scan over every body on the board; the run and the dismissal
// need somewhere to live; and the status is what stops one mention being answered twice.
//
// `agents.forum_mentions` is backfilled to true — an existing fleet should be reachable by default;
// muting is the deliberate act, not being addressable. It only governs the *alert*: a muted agent
// still gets its mentions, in its next turn's forum block.

const COLLECTION = 'forum_mentions';

module.exports = {
  async up(db) {
    const existing = await db.listCollections({ name: COLLECTION }).toArray();
    if (!existing.length) await db.createCollection(COLLECTION);

    // One agent's queue, the board-wide triage list, and the two cleanup paths (a deleted post or
    // thread takes its mentions with it — a queue entry pointing at nothing is pure noise).
    await db.collection(COLLECTION).createIndex({ 'target.agent_id': 1, status: 1, created_at: -1 });
    await db.collection(COLLECTION).createIndex({ status: 1, created_at: -1 });
    await db.collection(COLLECTION).createIndex({ post_id: 1 });
    await db.collection(COLLECTION).createIndex({ thread_id: 1 });

    await db
      .collection('agents')
      .updateMany({ forum_mentions: { $exists: false } }, { $set: { forum_mentions: true } });

    // Notifications gain a back-pointer, so a mention's inbox row can offer Run rather than being a
    // dead-end text record. Empty on every existing notification, which is exactly right — they are
    // about finished tasks, and there is nothing to act on.
    await db
      .collection('notifications')
      .updateMany({ kind: { $exists: false } }, { $set: { kind: '', ref_id: '' } });

    // Sessions gain a third `origin` (`forum`) plus a back-pointer to the thread that spawned them.
    // Backfilled explicitly rather than left to Mongoose defaults, which only apply to documents
    // written from now on — a listing that filters on a missing field returns nothing.
    await db
      .collection('sessions')
      .updateMany(
        { forum_thread_id: { $exists: false } },
        { $set: { forum_thread_id: null, forum_mention_id: null } },
      );
  },

  async down(db) {
    const existing = await db.listCollections({ name: COLLECTION }).toArray();
    if (existing.length) await db.collection(COLLECTION).drop();

    await db.collection('agents').updateMany({}, { $unset: { forum_mentions: '' } });
    await db.collection('notifications').deleteMany({ kind: 'forum_mention' });
    await db.collection('notifications').updateMany({}, { $unset: { kind: '', ref_id: '' } });
    // Sessions spawned by a mention stay — they are real conversations with real turns in them. Only
    // the now-meaningless back-pointers go, and the origin reverts to an ordinary operator chat.
    await db.collection('sessions').updateMany({ origin: 'forum' }, { $set: { origin: 'user' } });
    await db.collection('sessions').updateMany({}, { $unset: { forum_thread_id: '', forum_mention_id: '' } });
  },
};
