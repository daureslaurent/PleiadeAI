// Add the `model_vision` map to the `endpoints` collection: per-model auto-detected vision
// (multimodal) capability, probed at model discovery alongside `model_contexts` (`--mmproj` in
// `/v1/models` `status.args` on a llama.cpp router, `/props` `modalities.vision` on a single-model
// server). A probed reading overrides the manual `supports_vision` flag; models absent from the map
// fall back to it. Existing endpoints start empty and fill on the next "Refresh models".

module.exports = {
  async up(db) {
    await db.collection('endpoints').updateMany(
      { model_vision: { $exists: false } },
      { $set: { model_vision: {} } },
    );
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { model_vision: '' } });
  },
};
