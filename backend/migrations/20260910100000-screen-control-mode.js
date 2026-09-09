/**
 * Move "who reads the screen" from a per-tool select to one global setting (`VISUAL_MODAL_PLAN.md`).
 *
 * The `screen_analysis` field on `visual_screenshot` / `android_screenshot` answered the same
 * question twice for what is one concept, and said nothing about localization — which is where the
 * second model actually did the most damage. It is replaced by `settings.screen_control_mode`
 * (auto | modal | legacy).
 *
 * An operator who left both tools on `auto` gets `auto`, i.e. no change of behaviour. One who had
 * pinned a tool to `own_model` or `vision_endpoint` had that carried across rather than silently
 * reset — the desktop's choice wins if the two disagreed, since it governs more (the desktop is the
 * surface where localization exists at all).
 */
const PICK = { own_model: 'modal', vision_endpoint: 'legacy' };

module.exports = {
  async up(db) {
    const tools = await db
      .collection('tool_configs')
      .find({ name: { $in: ['visual_screenshot', 'android_screenshot'] } })
      .toArray();
    const pinned = (name) => PICK[tools.find((t) => t.name === name)?.config?.screen_analysis];
    const mode = pinned('visual_screenshot') || pinned('android_screenshot') || 'auto';

    await db
      .collection('settings')
      .updateMany({ screen_control_mode: { $exists: false } }, { $set: { screen_control_mode: mode } });
    await db
      .collection('tool_configs')
      .updateMany({ 'config.screen_analysis': { $exists: true } }, { $unset: { 'config.screen_analysis': '' } });
    // The key may also have been pinned; a lock on a field that no longer exists is dead weight.
    await db
      .collection('tool_configs')
      .updateMany({ locked: 'screen_analysis' }, { $pull: { locked: 'screen_analysis' } });
  },

  async down(db) {
    await db.collection('settings').updateMany({}, { $unset: { screen_control_mode: '' } });
  },
};
