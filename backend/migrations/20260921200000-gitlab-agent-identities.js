// One GitLab account per agent (`GITLAB_PLAN.md` §11).
//
// The fleet acted as a single bot account, so `git log` could not say which agent wrote a commit,
// per-agent permissions were unexpressible (permissions attach to accounts, and there was one), and
// the webhook router had to read an agent's name out of prose. Agents now get real GitLab users,
// created by a provisioning-only admin token.
//
// Mongoose defaults cover a field that has never been written, so what this migration is actually
// for is the index: `gitlab_username` is looked up on every inbound webhook to resolve an assignee
// to an agent, and that lookup should not be a collection scan on a fleet of any size.

const CONNECTION_DEFAULTS = {
  gitlab_auto_provision: true,
  gitlab_member_access_level: 30, // Developer
  gitlab_on_agent_delete: 'block',
  gitlab_user_email_domain: '',
};

module.exports = {
  async up(db) {
    // Webhook routing reads this on every delivery.
    await db.collection('agents').createIndex({ gitlab_username: 1 });

    const settings = await db.collection('settings').findOne({ key: 'global' });
    const missing = {};
    for (const [key, value] of Object.entries(CONNECTION_DEFAULTS)) {
      if (!settings || settings[key] === undefined) missing[key] = value;
    }
    if (Object.keys(missing).length) {
      await db.collection('settings').updateOne({ key: 'global' }, { $set: missing }, { upsert: true });
    }
  },

  async down(db) {
    // The identities themselves are left on the agents: the GitLab users still exist, still own
    // their commits, and dropping our record of them would orphan the accounts — an older build
    // would then provision a *second* user per agent and split each history across two accounts.
    // Only the settings this release introduced are removed.
    await db.collection('agents').dropIndex('gitlab_username_1').catch(() => {});
    const unset = {};
    for (const key of [...Object.keys(CONNECTION_DEFAULTS), 'gitlab_admin_token_enc']) unset[key] = '';
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: unset });
  },
};
