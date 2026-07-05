// Configurable session-title model. Adds `title_endpoint_id` / `title_model` to the settings
// singleton. Empty `title_endpoint_id` (the default) means titles reuse the responding agent's own
// endpoint + model; set it to route titles through a specific, usually cheaper endpoint.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateMany(
        { title_endpoint_id: { $exists: false } },
        { $set: { title_endpoint_id: '', title_model: '' } },
      );
  },

  async down(db) {
    await db
      .collection('settings')
      .updateMany({}, { $unset: { title_endpoint_id: '', title_model: '' } });
  },
};
