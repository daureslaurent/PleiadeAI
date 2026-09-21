// The fleet's run lane (`RUN_QUEUE_PLAN.md`).
//
// Before this, the two things that wake agents on their own — GitLab wakes and forum wakes — each
// drained a private in-memory array one run at a time, and neither could see the other. Two serial
// queues on one inference server is not a serial queue: the operator watched two turns stream at
// once and could not say why, and a restart mid-queue dropped whatever had not started with no
// record that it ever existed.
//
// One collection replaces both arrays, and it is the queue itself rather than a log of it. That is
// what makes the order survive a restart, lets a row be cancelled before it costs an inference
// call, and leaves a history to answer "why did nothing run last night" afterwards.
//
// The indexes are the claim (`status + priority + queued_at`, the sort the drain takes its next row
// with), the page's list (`source + queued_at`), and deduplication of retried deliveries.

module.exports = {
  async up(db) {
    await db.createCollection('run_queue').catch(() => {});
    await db.collection('run_queue').createIndex({ status: 1, priority: -1, queued_at: 1 });
    await db.collection('run_queue').createIndex({ source: 1, queued_at: -1 });
    await db.collection('run_queue').createIndex({ dedupe_key: 1, status: 1 });
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $set: { run_queue_paused: false } }, { upsert: true });
  },

  async down(db) {
    await db.collection('run_queue').drop().catch(() => {});
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: { run_queue_paused: '' } });
  },
};
