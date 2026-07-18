// Adds the `todos` collection — one working checklist per (session, agent), written by the
// `todowrite` tool and rendered as the live task list in chat. See TODO_TOOL_PLAN.md.
//
// Created explicitly (rather than left to Mongoose's implicit create) so the unique index exists
// before the first concurrent write: `replace` upserts on (session_id, agent_id), and without the
// index two simultaneous writes in one session could each insert their own list.

module.exports = {
  async up(db) {
    const existing = await db.listCollections({ name: 'todos' }).toArray();
    if (!existing.length) await db.createCollection('todos');

    await db.collection('todos').createIndex({ session_id: 1, agent_id: 1 }, { unique: true });
    await db.collection('todos').createIndex({ session_id: 1 });
  },

  async down(db) {
    await db.collection('todos').drop().catch(() => {
      /* already gone */
    });
  },
};
