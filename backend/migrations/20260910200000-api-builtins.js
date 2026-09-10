/**
 * The shipped API catalogue (`API_TOOL_PLAN.md` §8).
 *
 * The presets themselves are not written here — they are installed at boot from
 * `domain/apis/builtin-catalogue.ts`, so a preset added in a later release arrives without another
 * migration. What this does is backfill the fields that release added, on any API configured before
 * it: optional credentials, the OAuth2 client-credentials grant, and a per-operation host override.
 *
 * Mongoose would supply these defaults on read anyway; writing them makes a document inspected
 * directly in Mongo tell the same story as one read through the app.
 */
module.exports = {
  async up(db) {
    await db.collection('api_sources').updateMany({ builtin: { $exists: false } }, {
      $set: { builtin: false, auth_optional: false, secret_hint: '', token_url: '', auth_scope: '' },
    });
    // Per-operation host override, for services that split one API across domains.
    await db.collection('api_sources').updateMany(
      { 'operations.base_url': { $exists: false } },
      { $set: { 'operations.$[op].base_url': '' } },
      { arrayFilters: [{ 'op.base_url': { $exists: false } }] },
    );
    // Which presets this instance has already been offered — absent means "none yet", so a fresh
    // deploy installs the whole catalogue on its next boot.
    await db.collection('settings').updateMany(
      { api_builtins_installed: { $exists: false } },
      { $set: { api_builtins_installed: [] } },
    );
  },

  async down(db) {
    await db.collection('api_sources').updateMany({}, {
      $unset: { builtin: '', auth_optional: '', secret_hint: '', token_url: '', auth_scope: '' },
    });
    await db.collection('settings').updateMany({}, { $unset: { api_builtins_installed: '' } });
  },
};
