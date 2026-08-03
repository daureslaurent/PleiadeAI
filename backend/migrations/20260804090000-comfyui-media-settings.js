/**
 * ComfyUI media generation settings.
 *
 * `comfy_url` is the ComfyUI server behind `generate_image` / `generate_video` / `generate_sound` /
 * `edit_image` (Settings → Connections). Seeded empty on purpose: `settingsService.get()` falls back
 * to the `COMFY_URL` env var with `||`, so an empty string means "unset" rather than "no server", and
 * the media tools simply report they're unconfigured until the operator fills it in.
 *
 * `comfy_queue_max` bounds how deep a ComfyUI queue an agent will join — ComfyUI runs one job at a
 * time, so joining a pileup means blocking for the sum of everything ahead. 0 disables the check.
 */
module.exports = {
  async up(db) {
    await db.collection('settings').updateOne(
      { key: 'global', comfy_url: { $exists: false } },
      { $set: { comfy_url: '', comfy_queue_max: 3 } },
    );
  },

  async down(db) {
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $unset: { comfy_url: '', comfy_queue_max: '' } });
  },
};
