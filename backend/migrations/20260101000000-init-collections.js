// Initial schema: create the core collections and their indexes.
// migrate-mongo runs with the native driver (not Mongoose), so indexes are declared here
// explicitly rather than relying on Mongoose autoIndex (which is disabled in production).

module.exports = {
  async up(db) {
    await db.createCollection('agents');
    await db.collection('agents').createIndex({ name: 1 }, { unique: true });
    await db.collection('agents').createIndex({ qdrant_namespace: 1 }, { unique: true });

    await db.createCollection('notifications');
    await db.collection('notifications').createIndex({ agent_id: 1, created_at: -1 });
    await db.collection('notifications').createIndex({ status: 1 });

    await db.createCollection('skills');
    await db.collection('skills').createIndex({ name: 1 }, { unique: true });
    await db.collection('skills').createIndex({ enabled: 1 });
  },

  async down(db) {
    await db.collection('agents').drop().catch(() => {});
    await db.collection('notifications').drop().catch(() => {});
    await db.collection('skills').drop().catch(() => {});
  },
};
