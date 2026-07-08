// Records the algorithm of a profile's stored outbound SSH key so the container injects it under the
// filename `ssh` expects by default (`id_ed25519` / `id_rsa`). Existing keys were pasted before the
// server-side generator existed and use the ed25519 filename convention, so '' (→ ed25519) is the
// correct backfill.

module.exports = {
  async up(db) {
    await db
      .collection('isolations')
      .updateMany({ ssh_key_type: { $exists: false } }, { $set: { ssh_key_type: '' } });
  },

  async down(db) {
    await db.collection('isolations').updateMany({}, { $unset: { ssh_key_type: '' } });
  },
};
