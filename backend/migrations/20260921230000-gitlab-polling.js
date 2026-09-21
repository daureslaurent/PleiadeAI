// GitLab polling (`GITLAB_PLAN.md` §13).
//
// Webhooks are the wrong shape for most self-hosted instances — group hooks are a paid feature and
// project hooks have to be armed one repository at a time — so the fleet now *asks* GitLab what
// happened. Two things need to exist before the first tick: the settings the operator switches it
// on with, and the collection that remembers how far each source has been read.
//
// The cursor collection is the part that matters here. Without a stored cursor a restart replays a
// day of GitLab activity and starts a turn per row, which is a mistake discovered by the inference
// bill; `key` is unique so two ticks racing cannot create two cursors for one source.

const POLL_DEFAULTS = {
  gitlab_poll_enabled: false,
  gitlab_poll_interval_minutes: 5,
  gitlab_poll_events: [],
  gitlab_poll_projects: [],
  gitlab_poll_max_wakes: 5,
};

module.exports = {
  async up(db) {
    await db.createCollection('gitlab_poll_state').catch(() => {});
    await db.collection('gitlab_poll_state').createIndex({ key: 1 }, { unique: true });

    const settings = await db.collection('settings').findOne({ key: 'global' });
    const missing = {};
    for (const [key, value] of Object.entries(POLL_DEFAULTS)) {
      if (!settings || settings[key] === undefined) missing[key] = value;
    }
    if (Object.keys(missing).length) {
      await db.collection('settings').updateOne({ key: 'global' }, { $set: missing }, { upsert: true });
    }
  },

  async down(db) {
    await db.collection('gitlab_poll_state').drop().catch(() => {});
    const unset = {};
    for (const key of Object.keys(POLL_DEFAULTS)) unset[key] = '';
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: unset });
    // The repeating tick itself lives in `agenda_jobs`, and an older build has no handler for it:
    // cancel it here rather than leaving it to fail every five minutes forever.
    await db.collection('agenda_jobs').deleteMany({ name: 'gitlab:poll' });
  },
};
