/**
 * Retire the sd-server image path.
 *
 * `generate_image` used to POST to an OpenAI-compatible `/v1/images/generations` server selected by
 * `image_endpoint_id` / `image_model`. It now runs an operator-chosen ComfyUI workflow instead
 * (`comfy_url`, plus a workflow picked per tool on the Tools page), so these two keys have no reader
 * left and are removed rather than left to rot as settings that appear to do something.
 *
 * `down` restores them as empty strings — their original defaults — which is the "unconfigured" state
 * the old tool reported cleanly.
 */
module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $unset: { image_endpoint_id: '', image_model: '' } });
  },

  async down(db) {
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $set: { image_endpoint_id: '', image_model: '' } });
  },
};
