// Every turn an agent runs becomes a conversation in its Workspace list, not only the ones typed
// there. Sessions gain three `origin`s — `cron` (one per scheduled run), `telegram` (one per chat,
// until `/new`), `flow` (one per agent node run) — and the back-pointers each needs.
//
// Backfilled explicitly rather than left to Mongoose defaults, which only apply to documents written
// from now on. The index serves the Telegram bot's "this chat's current conversation" lookup, which
// runs on every message.

module.exports = {
  async up(db) {
    await db
      .collection('sessions')
      .updateMany(
        { schedule_id: { $exists: false } },
        { $set: { schedule_id: null, telegram_chat_id: null, flow_id: null, flow_run_id: null } },
      );
    await db.collection('sessions').createIndex({ origin: 1, telegram_chat_id: 1, agent_id: 1, created_at: -1 });
  },

  async down(db) {
    await db
      .collection('sessions')
      .dropIndex('origin_1_telegram_chat_id_1_agent_id_1_created_at_-1')
      .catch(() => undefined);
    // The conversations stay — they hold real turns. Only the origin reverts to an ordinary chat.
    await db
      .collection('sessions')
      .updateMany({ origin: { $in: ['cron', 'telegram', 'flow'] } }, { $set: { origin: 'user' } });
    await db
      .collection('sessions')
      .updateMany({}, { $unset: { schedule_id: '', telegram_chat_id: '', flow_id: '', flow_run_id: '' } });
  },
};
