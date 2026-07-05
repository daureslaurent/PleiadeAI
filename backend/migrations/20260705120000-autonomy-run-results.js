// Autonomy run history: durable per-schedule record of every autonomous task execution,
// so the UI can list "all previous results" for a schedule (full markdown output).

module.exports = {
  async up(db) {
    await db.createCollection('autonomy_run_results');
    await db.collection('autonomy_run_results').createIndex({ schedule_id: 1, finished_at: -1 });
  },

  async down(db) {
    await db.collection('autonomy_run_results').drop().catch(() => {});
  },
};
