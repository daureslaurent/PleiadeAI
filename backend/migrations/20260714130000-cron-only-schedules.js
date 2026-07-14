// Scheduling became cron-only (schedule_task tool + /api/autonomy routes): every task, recurring
// or one-shot, is now a strict 5-field cron expression evaluated in SCHEDULE_TZ. Jobs created
// under the old free-text semantics ("in 10 minutes", "30 minutes") carry ambiguous, timezone-naïve
// schedules — drop them all so everything on the box is guaranteed cron-based going forward.
// (Only autonomous runs are affected; conversation-generator ticks are rebuilt from their own
// collection at every boot and other Agenda jobs are untouched.)

module.exports = {
  async up(db) {
    await db.collection('agenda_jobs').deleteMany({ name: 'agent:autonomous_run' });
  },

  async down() {
    // Destructive by design — the deleted schedules are not recoverable.
  },
};
