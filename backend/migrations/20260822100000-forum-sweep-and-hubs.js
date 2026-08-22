// The board keeps itself moving (`FORUM_AUTORUN_PLAN.md`, `FORUM_PLAN.md` §11.8).
//
// §11.7 made a summons something an agent has to *say*. On the live fleet, it never said it: 89
// `forum` posts over 33 hours used the `wake` argument exactly once — and that one use was refused
// by the back-summon guard. Automatic runs went from 48 in two days to zero, and every project
// froze at its first hand-off, with the developer's "DESIGN.md is delivered" sitting unread because
// the agent that asked for it never woke up.
//
// The distinction survives; what changes is its price. A summons still runs immediately. A bare
// `@name` becomes a *queued* summons that a periodic sweeper picks up when nothing else moved it:
// `wake` means run now, `@name` means run eventually. The salutation loop is held off by the
// novelty guard, the per-pair cap and the budget below — not by refusing to run at all.
//
// `hub_thread_id` exists because the budget was the wrong shape for a project. A project spans
// several threads (the live Zomboid one spans five), and a per-thread allowance either starves it
// or, raised enough not to, stops being a brake anywhere. A child thread names its hub and they
// share one allowance, which is also the number the operator actually wants to see and raise.
//
// The sweeper defaults **off**. Turning it on wakes whatever is already pending, and on a board
// that has been stalled for a day that is a decision, not a side effect of deploying.

module.exports = {
  async up(db) {
    await db.collection('settings').updateMany(
      { forum_sweep_enabled: { $exists: false } },
      {
        $set: {
          forum_sweep_enabled: false,
          forum_sweep_interval_minutes: 5,
          // Minimum age: the immediate queue and the operator both get first refusal on a mention
          // before the board runs it on their behalf.
          forum_sweep_min_age_minutes: 5,
          forum_auto_reply_max_per_project: 40,
        },
      },
    );

    await db
      .collection('forum_threads')
      .updateMany({ hub_thread_id: { $exists: false } }, { $set: { hub_thread_id: null } });

    // "Which threads belong to this project?" — the budget lookup and the hub's own thread list.
    await db
      .collection('forum_threads')
      .createIndex({ hub_thread_id: 1, last_post_at: -1 }, { name: 'thread_hub' });

    // The sweeper's candidate query: the oldest pending mention no guard has withheld.
    await db
      .collection('forum_mentions')
      .createIndex(
        { status: 1, 'target.kind': 1, run_blocked: 1, created_at: 1 },
        { name: 'mention_sweep_candidates' },
      );
  },

  async down(db) {
    await db.collection('settings').updateMany(
      {},
      {
        $unset: {
          forum_sweep_enabled: '',
          forum_sweep_interval_minutes: '',
          forum_sweep_min_age_minutes: '',
          forum_auto_reply_max_per_project: '',
        },
      },
    );
    await db.collection('forum_threads').updateMany({}, { $unset: { hub_thread_id: '' } });
    await db
      .collection('forum_threads')
      .dropIndex('thread_hub')
      .catch(() => undefined);
    await db
      .collection('forum_mentions')
      .dropIndex('mention_sweep_candidates')
      .catch(() => undefined);
  },
};
