// Adds the agent Forum (`FORUM_PLAN.md`): a shared, human-readable board where agents file durable
// findings, coordinate work, and argue proposals to a verdict — the cross-agent counterpart to the
// strictly-siloed per-agent Qdrant memory.
//
// Collections are created explicitly rather than left to Mongoose's implicit create so the indexes
// exist before the first concurrent write: several agents can post into the same thread in the same
// second, and the thread-listing and text indexes should never be missing under that load.
//
// The four seed categories ship here so the board is never an empty page on first boot — an empty
// forum is one no agent has any reason to search, which is how the feature would die on day one.

const COLLECTIONS = ['forum_categories', 'forum_threads', 'forum_posts'];

const SEED_CATEGORIES = [
  {
    name: 'Knowledge Base',
    slug: 'knowledge-base',
    description: 'Durable findings, gotchas and how-tos worth keeping. Search here before asking.',
    position: 10,
  },
  {
    name: 'Coordination',
    slug: 'coordination',
    description: 'Dividing work, status reports and handoffs between agents.',
    position: 20,
  },
  {
    name: 'Proposals & Review',
    slug: 'proposals-review',
    description: 'Post a proposal, collect objections, mark the reply that settles it.',
    position: 30,
  },
  {
    name: 'General',
    slug: 'general',
    description: 'Anything that does not belong in the other sections yet.',
    position: 40,
  },
];

module.exports = {
  async up(db) {
    for (const name of COLLECTIONS) {
      const existing = await db.listCollections({ name }).toArray();
      if (!existing.length) await db.createCollection(name);
    }

    await db.collection('forum_categories').createIndex({ name: 1 }, { unique: true });
    await db.collection('forum_categories').createIndex({ slug: 1 }, { unique: true });
    await db.collection('forum_categories').createIndex({ position: 1, name: 1 });

    await db.collection('forum_threads').createIndex({ category_id: 1, pinned: -1, last_post_at: -1 });
    await db.collection('forum_threads').createIndex({ status: 1, last_post_at: -1 });
    await db.collection('forum_threads').createIndex({ title: 'text' });

    await db.collection('forum_posts').createIndex({ thread_id: 1, created_at: 1 });
    await db.collection('forum_posts').createIndex({ category_id: 1 });
    await db.collection('forum_posts').createIndex({ body: 'text' });

    const now = new Date();
    for (const category of SEED_CATEGORIES) {
      await db.collection('forum_categories').updateOne(
        { slug: category.slug },
        {
          $setOnInsert: {
            ...category,
            enabled: true,
            agents_can_post: true,
            created_at: now,
            updated_at: now,
          },
        },
        { upsert: true },
      );
    }
  },

  async down(db) {
    for (const name of [...COLLECTIONS].reverse()) {
      await db
        .collection(name)
        .drop()
        .catch(() => {
          /* already gone */
        });
    }
  },
};
