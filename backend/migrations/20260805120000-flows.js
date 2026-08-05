// Adds the `flows` and `flow_runs` collections — operator-authored node graphs the backend executes
// in a fixed order, and one document per execution. See FLOWS_PLAN.md.
//
// Created explicitly rather than left to Mongoose's implicit create so the unique index on
// `flows.name` exists before the first write: the `run_flow` tool and the cron schedule both address
// a flow *by name*, so two flows sharing one would make "run the pipeline" ambiguous.

module.exports = {
  async up(db) {
    for (const name of ['flows', 'flow_runs']) {
      const existing = await db.listCollections({ name }).toArray();
      if (!existing.length) await db.createCollection(name);
    }

    await db.collection('flows').createIndex({ name: 1 }, { unique: true });

    // History is always read newest-first for one flow, and the run's own id doubles as its resource
    // session, so `session_id` is looked up directly when resolving artifacts.
    await db.collection('flow_runs').createIndex({ flow_id: 1, started_at: -1 });
    await db.collection('flow_runs').createIndex({ status: 1 });
    await db.collection('flow_runs').createIndex({ session_id: 1 });
  },

  async down(db) {
    for (const name of ['flow_runs', 'flows']) {
      await db
        .collection(name)
        .drop()
        .catch(() => {
          /* already gone */
        });
    }
  },
};
