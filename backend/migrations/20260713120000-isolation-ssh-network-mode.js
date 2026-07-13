// Adds the remote execution target for the new `ssh` network mode, where the agent container acts as
// a jump box and bash/file-tools/skills all run on a remote host over SSH (see SSH_ISOLATION_PLAN.md).
// Existing profiles are on host/bridge/none/vpn, so an empty target is the correct backfill — it is
// only read when `network === 'ssh'`.

module.exports = {
  async up(db) {
    await db.collection('isolations').updateMany(
      { ssh_remote_host: { $exists: false } },
      { $set: { ssh_remote_host: '', ssh_remote_port: 22, ssh_remote_user: '' } },
    );
  },

  async down(db) {
    // Profiles left on `ssh` would have no target to execute against — put them back on the default.
    await db
      .collection('isolations')
      .updateMany({ network: 'ssh' }, { $set: { network: 'host' } });
    await db
      .collection('isolations')
      .updateMany(
        {},
        { $unset: { ssh_remote_host: '', ssh_remote_port: '', ssh_remote_user: '' } },
      );
  },
};
