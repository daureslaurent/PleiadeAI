// Read-only Gmail for agents (GMAIL_TOOL_PLAN.md). Adds the Google OAuth client fields to the
// settings singleton, backfills the per-agent mailbox grant list, and indexes the new
// `mail_accounts` collection (one doc per linked mailbox; refresh tokens AES-256-GCM encrypted,
// written only by the OAuth callback).

module.exports = {
  async up(db) {
    await db.collection('settings').updateMany(
      { public_base_url: { $exists: false } },
      { $set: { public_base_url: '', google_client_id: '', google_client_secret: '' } },
    );
    await db.collection('agents').updateMany(
      { mail_accounts: { $exists: false } },
      { $set: { mail_accounts: [] } },
    );
    await db.collection('mail_accounts').createIndex({ email: 1 }, { unique: true });
  },

  async down(db) {
    await db.collection('settings').updateMany(
      {},
      { $unset: { public_base_url: '', google_client_id: '', google_client_secret: '' } },
    );
    await db.collection('agents').updateMany({}, { $unset: { mail_accounts: '' } });
    await db.collection('mail_accounts').drop().catch(() => {});
  },
};
