// Internal git server (`GIT_SERVER_PLAN.md` §2): one Forgejo account per agent, recorded in
// `git_identities`. Nothing is provisioned here — accounts are made lazily by the backend the first
// time an isolated agent runs with git enabled, because that needs the Forgejo API, not the database.

module.exports = {
  async up(db) {
    const identities = db.collection('git_identities');
    await identities.createIndex({ agent_id: 1 }, { unique: true });
    await identities.createIndex({ username: 1 }, { unique: true });
  },

  async down(db) {
    await db.collection('git_identities').drop().catch(() => undefined);
  },
};
