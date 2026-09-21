// GitLab as a fleet capability (`GITLAB_PLAN.md`).
//
// Most of what this release adds needs no migration — Mongoose defaults cover a settings key that
// has never been written, and the nine tools are code. Two things do:
//
//   1. `gitlab_activity` wants its indexes before it is first written to, not after. The feed query
//      is always "newest first, optionally for one project", and a collection that grows a row per
//      commit will be answering that query for a long time.
//   2. The settings singleton gets the connection's non-secret defaults written explicitly. This is
//      not strictly required, but it means `GET /api/gitlab/connection` returns the same shape on a
//      fresh instance as on a configured one, so the settings page has no "never saved" branch.
//
// The three encrypted fields are deliberately NOT seeded: absent and empty both read as "unset",
// and writing `''` for a `select: false` field would only make the difference harder to see.

const CONNECTION_DEFAULTS = {
  gitlab_url: '',
  gitlab_group: '',
  gitlab_bot_username: '',
  gitlab_default_agent_id: '',
  gitlab_project_agents: [],
  gitlab_wake_issues: false,
  gitlab_wake_reviews: false,
  gitlab_git_transport: 'https',
  gitlab_ssh_host: '',
  gitlab_ssh_port: 22,
};

module.exports = {
  async up(db) {
    const activity = db.collection('gitlab_activity');
    await activity.createIndex({ at: -1 });
    await activity.createIndex({ project: 1, at: -1 });
    await activity.createIndex({ agent_id: 1, at: -1 });
    await activity.createIndex({ session_id: 1 });

    // `$setOnInsert` semantics by hand: only write a key that isn't there, so re-running this
    // migration on an instance where the operator has already configured GitLab cannot wipe it.
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
    // The activity feed is a record of work the fleet actually did — dropping it on a rollback would
    // destroy history that GitLab itself does not hold (which agent, in which conversation). The
    // collection is left in place; only the settings keys this release introduced are removed.
    const unset = {};
    for (const key of [
      ...Object.keys(CONNECTION_DEFAULTS),
      'gitlab_token_enc',
      'gitlab_webhook_secret_enc',
      'gitlab_ssh_key_enc',
    ]) {
      unset[key] = '';
    }
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: unset });
  },
};
