// Add the shared Google APIs credentials to the settings singleton (Settings → Connections →
// Google APIs): `google_api_key` (one Google Cloud API key for Custom Search / YouTube Data v3 /
// Maps) and `google_cse_id` (the Programmable Search Engine id the web_search google provider
// queries). Distinct from the existing `google_client_id/secret` OAuth client, which is only for
// linking Gmail mailboxes. Both start empty; tools report "unconfigured" until the operator fills
// them in.

module.exports = {
  async up(db) {
    await db.collection('settings').updateMany(
      { google_api_key: { $exists: false } },
      { $set: { google_api_key: '', google_cse_id: '' } },
    );
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { google_api_key: '', google_cse_id: '' } });
  },
};
