/**
 * The last call, not the last failure (`API_TOOL_PLAN.md` §7).
 *
 * `last_error` could not answer the question Settings → APIs actually asks. An empty one means
 * either "this API is healthy" or "nobody has ever called it", and those are the two states an
 * operator most needs to tell apart. `last_call` records every outcome, success included.
 *
 * Existing rows carry across as much as they can: a recorded error becomes a failed call, a
 * timestamp with no error becomes a successful one, and an API never called stays null.
 */
module.exports = {
  async up(db) {
    const sources = await db
      .collection('api_sources')
      .find({ $or: [{ last_error: { $ne: '' } }, { last_used_at: { $ne: null } }] })
      .toArray();

    for (const s of sources) {
      if (!s.last_error && !s.last_used_at) continue;
      await db.collection('api_sources').updateOne(
        { _id: s._id },
        {
          $set: {
            last_call: {
              operation: '',
              ok: !s.last_error,
              status: null,
              duration_ms: 0,
              at: s.last_used_at ?? new Date(),
              error: s.last_error ?? '',
              via: 'agent',
              agent: '',
            },
          },
        },
      );
    }

    await db.collection('api_sources').updateMany({}, { $unset: { last_error: '', last_used_at: '' } });
  },

  async down(db) {
    const sources = await db.collection('api_sources').find({ last_call: { $ne: null } }).toArray();
    for (const s of sources) {
      if (!s.last_call) continue;
      await db.collection('api_sources').updateOne(
        { _id: s._id },
        { $set: { last_error: s.last_call.error ?? '', last_used_at: s.last_call.at ?? null } },
      );
    }
    await db.collection('api_sources').updateMany({}, { $unset: { last_call: '' } });
  },
};
