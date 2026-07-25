// Moves the inference reliability / failover tunables from the INFERENCE_* env vars into runtime
// settings, so they are editable from Settings → Inference without a redeploy:
//   - inference_first_token_timeout_ms   per-attempt time-to-first-token budget before failover
//   - inference_health_poll_interval_ms  background health-breaker probe interval
//   - inference_health_failure_threshold consecutive failures before an endpoint is parked down
//   - inference_health_cooldown_ms       how long a down endpoint stays skipped before a re-check
//
// Seeded to `null` rather than numbers: `settingsService.get()` falls back to the env defaults when a
// field is null, so an existing deployment keeps its current behaviour until the operator sets one.

const FIELDS = [
  'inference_first_token_timeout_ms',
  'inference_health_poll_interval_ms',
  'inference_health_failure_threshold',
  'inference_health_cooldown_ms',
];

module.exports = {
  async up(db) {
    const set = {};
    for (const f of FIELDS) set[f] = null;
    await db
      .collection('settings')
      .updateOne(
        { key: 'global', inference_first_token_timeout_ms: { $exists: false } },
        { $set: set },
      );
  },

  async down(db) {
    const unset = {};
    for (const f of FIELDS) unset[f] = '';
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: unset });
  },
};
