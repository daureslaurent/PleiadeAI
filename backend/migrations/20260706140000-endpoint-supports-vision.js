// Add the advisory `supports_vision` flag to the `endpoints` collection. Marks an endpoint whose
// model is multimodal (llama.cpp launched with `--mmproj`, or a vision-capable vLLM/Ollama model),
// so the UI can warn when a visual agent is paired with a text-only endpoint. Existing endpoints
// default to non-vision.

module.exports = {
  async up(db) {
    await db.collection('endpoints').updateMany(
      { supports_vision: { $exists: false } },
      { $set: { supports_vision: false } },
    );
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { supports_vision: '' } });
  },
};
