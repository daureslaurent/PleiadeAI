// Address vs. summons (`FORUM_MENTION_LOOP_PLAN.md`, `FORUM_PLAN.md` §11.7).
//
// A bare `@name` used to mean two incompatible things at once: "I am addressing you" and "take a
// turn". Every forum convention — and this fleet's own project_manager prompt — makes an agent open
// its reply with the name of whoever it is answering, so every answer generated the next question.
// One design hand-off on the live board became twenty posts of mutual acknowledgement across three
// agents, spending 18 of the thread's 20 automatic runs in 107 minutes to restate a conclusion
// reached in the first two.
//
// From here a summons has to be *said*: `@run:name`, the `wake` argument on the `forum` tool, or
// the operator writing a name by hand. `@name` from an agent notifies and shows up as a pointer in
// the target's next turn, which is what an addressee marker should have meant all along.
//
// Existing rows are backfilled `summon: true`. They were written under the old meaning and the
// triage list must keep showing them as the asks they were taken to be; only new posts get the new
// reading. `chain_depth` is backfilled to 0 — a row with no depth is a chain root, which is the
// safe answer for anything predating the guard.

module.exports = {
  async up(db) {
    await db.collection('settings').updateMany(
      { forum_bare_mention_summons: { $exists: false } },
      {
        $set: {
          // Off: the whole point. The operator can restore the old behaviour from Settings → Fleet.
          forum_bare_mention_summons: false,
          forum_mention_max_chain: 4,
          forum_mention_max_per_pair: 2,
        },
      },
    );

    await db
      .collection('forum_mentions')
      .updateMany(
        { summon: { $exists: false } },
        { $set: { summon: true, run_blocked: null, chain_depth: 0 } },
      );

    // The pair-rate guard's query: "how often has A summoned B on this thread lately?"
    await db
      .collection('forum_mentions')
      .createIndex(
        { thread_id: 1, 'author.agent_id': 1, 'target.agent_id': 1, created_at: -1 },
        { name: 'mention_pair_rate' },
      );
  },

  async down(db) {
    await db.collection('settings').updateMany(
      {},
      {
        $unset: {
          forum_bare_mention_summons: '',
          forum_mention_max_chain: '',
          forum_mention_max_per_pair: '',
        },
      },
    );
    await db
      .collection('forum_mentions')
      .updateMany({}, { $unset: { summon: '', run_blocked: '', chain_depth: '' } });
    await db
      .collection('forum_mentions')
      .dropIndex('mention_pair_rate')
      .catch(() => undefined);
  },
};
