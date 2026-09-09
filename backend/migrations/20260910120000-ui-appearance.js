/**
 * Seed the operator's appearance choice (`THEME_SYSTEM_PLAN.md` §2.3).
 *
 * The frontend gained a theme system and a set of chat layouts; which one the operator picked is
 * stored on the settings singleton so it follows them to another browser. Existing instances get
 * the pair that reproduces exactly what they see today — the Pleiades theme and the hybrid chat
 * layout — so applying this migration changes nothing until someone opens the picker.
 *
 * Only documents missing the field are touched: re-running must not overwrite a choice already made.
 */
module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany({ ui_theme: { $exists: false } }, { $set: { ui_theme: 'pleiades' } });
    await db
      .collection('settings')
      .updateMany({ ui_chat_layout: { $exists: false } }, { $set: { ui_chat_layout: 'hybrid' } });
  },

  async down(db) {
    await db
      .collection('settings')
      .updateMany({}, { $unset: { ui_theme: '', ui_chat_layout: '' } });
  },
};
