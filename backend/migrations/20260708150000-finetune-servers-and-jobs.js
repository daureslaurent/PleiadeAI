// Fine-Tuning page. Creates the `finetune_servers` collection (remote GPU training servers; the
// bearer token is stored encrypted as `api_key_enc`) and the `finetune_jobs` collection (the durable
// record of each training run — the remote service keeps job state in memory only).
//
// Also relaxes `notifications.agent_id` to be nullable: a finished fine-tune raises a system-level
// inbox alert that belongs to no agent. Existing documents are untouched (they all carry an agent).

module.exports = {
  async up(db) {
    await db.createCollection('finetune_servers').catch(() => {});
    await db.collection('finetune_servers').createIndex({ name: 1 }, { unique: true });

    await db.createCollection('finetune_jobs').catch(() => {});
    // The poller scans by status; the UI lists newest-first; lookups join back to the server.
    await db.collection('finetune_jobs').createIndex({ status: 1 });
    await db.collection('finetune_jobs').createIndex({ created_at: -1 });
    await db.collection('finetune_jobs').createIndex({ server_id: 1 });
    await db.collection('finetune_jobs').createIndex({ remote_job_id: 1 });
  },

  async down(db) {
    await db.collection('finetune_jobs').drop().catch(() => {});
    await db.collection('finetune_servers').drop().catch(() => {});
  },
};
