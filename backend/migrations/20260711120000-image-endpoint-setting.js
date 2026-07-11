// Image generation endpoint for the `generate_image` tool. Adds `image_endpoint_id` + `image_model`
// to the settings singleton — a pointer to an OpenAI-compatible `/v1/images/generations` server
// (e.g. the bundled image-gen/ stable-diffusion.cpp FLUX box). Empty by default → the tool reports
// it's unconfigured until an operator picks an endpoint in Settings → Image endpoint. Purely additive.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany(
        { image_endpoint_id: { $exists: false } },
        { $set: { image_endpoint_id: '', image_model: '' } },
      );
  },

  async down(db) {
    await db
      .collection('settings')
      .updateMany({}, { $unset: { image_endpoint_id: '', image_model: '' } });
  },
};
