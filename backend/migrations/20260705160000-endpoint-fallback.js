// Runtime inference failover fields on endpoints:
//   - `fallback_order`: 0 = not in the fallback chain; >0 = ascending position the inference client
//     walks when the primary target is unreachable.
//   - `managed`: system-managed endpoint (the built-in local docker fallback).
// The local fallback endpoint itself is no longer seeded here — the backend *ensures* it at boot
// (endpointService.ensureLocalFallback: forced URL from LLAMA_FALLBACK_URL + auto model discovery),
// so it appears even without running migrations and self-heals. This migration only backfills the
// two fields on any endpoints that predate them.

module.exports = {
  async up(db) {
    await db
      .collection('endpoints')
      .updateMany({ fallback_order: { $exists: false } }, { $set: { fallback_order: 0 } });
    await db
      .collection('endpoints')
      .updateMany({ managed: { $exists: false } }, { $set: { managed: false } });
  },

  async down(db) {
    await db.collection('endpoints').updateMany({}, { $unset: { fallback_order: '', managed: '' } });
  },
};
