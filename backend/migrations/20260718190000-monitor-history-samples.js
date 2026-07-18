// Adds `monitor_history_samples` — how many history samples the Monitor poller keeps per machine in
// RAM. 720 ≈ 2h at the default 10s poll, matching the depth that was previously hard-coded, so an
// existing deployment sees no behaviour change until the operator raises it.
//
// The poller clamps the value to 60…100000 regardless of what is stored here.

module.exports = {
  async up(db) {
    await db
      .collection('settings')
      .updateOne(
        { key: 'global', monitor_history_samples: { $exists: false } },
        { $set: { monitor_history_samples: 720 } },
      );
  },

  async down(db) {
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: { monitor_history_samples: '' } });
  },
};
