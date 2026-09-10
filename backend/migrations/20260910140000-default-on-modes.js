/**
 * Standing inference modes (`MODES_PLAN.md` §5): a mode can be on for every call without anyone
 * picking it.
 *
 * Three fields, all of them written as "off" so applying this migration changes nothing about how
 * any existing conversation runs:
 *
 * - `endpoints.modes[].default_on` — the per-model flag.
 * - `settings.global_modes[].default_on` — the same flag on the operator's fleet-wide prompt modes.
 *   (The built-ins have no document to carry it, so theirs lives in `global_modes_default_on`,
 *   seeded empty here for the same reason `global_modes_disabled` was.)
 * - `sessions.modes_off` — the conversation's explicit opt-outs. Needed because a default cannot be
 *   undone by omission: with standing modes in play, an id absent from `mode_ids` no longer means
 *   "switched off", so unticking one has to be recorded.
 *
 * Mongoose would default all three on read, but writing them makes the shape true in the database
 * for anything that queries it directly.
 */
module.exports = {
  async up(db) {
    await db
      .collection('endpoints')
      .updateMany({ 'modes.0': { $exists: true } }, { $set: { 'modes.$[].default_on': false } });
    await db
      .collection('settings')
      .updateMany({ 'global_modes.0': { $exists: true } }, { $set: { 'global_modes.$[].default_on': false } });
    await db
      .collection('settings')
      .updateMany({ global_modes_default_on: { $exists: false } }, { $set: { global_modes_default_on: [] } });
    await db
      .collection('sessions')
      .updateMany({ modes_off: { $exists: false } }, { $set: { modes_off: [] } });
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { 'modes.$[].default_on': '' } });
    await db
      .collection('settings')
      .updateMany({}, { $unset: { 'global_modes.$[].default_on': '', global_modes_default_on: '' } });
    await db.collection('sessions').updateMany({}, { $unset: { modes_off: '' } });
  },
};
