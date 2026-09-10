/**
 * The module system (`MODULES_PLAN.md` §9).
 *
 * Adds the three fields the settings singleton carries for it, and seeds the one module that does
 * not ship on: the board. `forum_board_enabled` was its switch before this existed, so an install
 * where it was off must come back with the board module off too — otherwise the upgrade quietly
 * starts a scheduler the operator had deliberately left alone.
 */
module.exports = {
  async up(db) {
    const settings = db.collection('settings');
    const doc = await settings.findOne({ key: 'global' });
    const boardWasOn = doc?.forum_board_enabled === true;

    await settings.updateOne(
      { key: 'global' },
      {
        $set: {
          modules_disabled: boardWasOn ? [] : ['board'],
          module_overrides: {},
          modules_custom: [],
        },
      },
      { upsert: true },
    );
  },

  async down(db) {
    await db
      .collection('settings')
      .updateOne(
        { key: 'global' },
        { $unset: { modules_disabled: '', module_overrides: '', modules_custom: '' } },
      );
  },
};
