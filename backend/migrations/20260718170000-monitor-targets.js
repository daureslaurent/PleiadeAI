// Fleet monitoring (Monitor page). Creates the `monitor_targets` collection with its unique-name
// index, and seeds the `monitor_*` threshold/poll defaults on the settings singleton so an existing
// deployment adopts the same limits the schema defaults would give a fresh one.
//
// Thresholds are conservative for consumer hardware: an Intel package reports `high` around 82°C,
// and NVIDIA consumer cards start throttling in the 83-93°C range.

const MONITOR_DEFAULTS = {
  monitor_poll_seconds: 10,
  monitor_alerts_enabled: true,
  monitor_cpu_temp_warn: 80,
  monitor_cpu_temp_critical: 90,
  monitor_gpu_temp_warn: 80,
  monitor_gpu_temp_critical: 88,
  monitor_memory_warn: 85,
  monitor_memory_critical: 95,
  monitor_vram_warn: 90,
  monitor_vram_critical: 97,
  monitor_disk_warn: 85,
  monitor_disk_critical: 95,
  monitor_alert_cooldown_minutes: 30,
};

module.exports = {
  async up(db) {
    const names = await db.listCollections({ name: 'monitor_targets' }).toArray();
    if (!names.length) await db.createCollection('monitor_targets');
    await db.collection('monitor_targets').createIndex({ name: 1 }, { unique: true });

    // Only fill keys that are absent — never clobber a threshold the operator already tuned.
    const settings = await db.collection('settings').findOne({ key: 'global' });
    const missing = Object.fromEntries(
      Object.entries(MONITOR_DEFAULTS).filter(([k]) => !settings || settings[k] === undefined),
    );
    if (Object.keys(missing).length) {
      await db.collection('settings').updateOne({ key: 'global' }, { $set: missing }, { upsert: true });
    }
  },

  async down(db) {
    await db.collection('monitor_targets').drop().catch(() => undefined);
    await db
      .collection('settings')
      .updateOne({ key: 'global' }, { $unset: Object.fromEntries(Object.keys(MONITOR_DEFAULTS).map((k) => [k, ''])) });
  },
};
