// Add an optional remote `sudo` password to isolation profiles. It is injected into each agent
// container at create time as a mode-600 file (+ a SUDO_ASKPASS helper) so the agent can escalate
// with `sudo` on a remote host it has SSH'd into. The password is stored AES-256-GCM encrypted at
// rest in `sudo_password_enc`. Existing profiles default to no password.

module.exports = {
  async up(db) {
    await db.collection('isolations').updateMany(
      { sudo_password_enc: { $exists: false } },
      { $set: { sudo_password_enc: null } },
    );
  },

  async down(db) {
    await db.collection('isolations').updateMany({}, { $unset: { sudo_password_enc: '' } });
  },
};
