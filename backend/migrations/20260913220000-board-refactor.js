// Board refactor (`BOARD_REFACTOR_PLAN.md`): a board item is a task or a project, has a name and a
// description, and owns one persistent conversation with its manager. Chat turns in that conversation
// file proposals (`forum_plan_proposals`) instead of writing to the board.
//
// Existing plans become projects named after their goal. Their chat session is left null and made
// the first time the board page opens them, because creating a session needs the agent document and
// a migration is the wrong place to reach for it.

module.exports = {
  async up(db) {
    const plans = db.collection('forum_plans');
    const cursor = plans.find({ kind: { $exists: false } });
    for await (const plan of cursor) {
      const goal = String(plan.goal || '').trim();
      const name = goal.length > 80 ? `${goal.slice(0, 77)}…` : goal;
      await plans.updateOne(
        { _id: plan._id },
        { $set: { kind: 'project', name, description: '', acceptance: [], chat_session_id: null } },
      );
    }
    await plans.createIndex({ kind: 1 });

    await db
      .collection('sessions')
      .updateMany({ board_plan_id: { $exists: false } }, { $set: { board_plan_id: null } });
    await db.collection('sessions').createIndex({ board_plan_id: 1 });

    const proposals = db.collection('forum_plan_proposals');
    await proposals.createIndex({ plan_id: 1 });
    await proposals.createIndex({ plan_id: 1, state: 1, created_at: -1 });
  },

  async down(db) {
    await db.collection('forum_plan_proposals').drop().catch(() => undefined);
    await db.collection('sessions').dropIndex('board_plan_id_1').catch(() => undefined);
    await db
      .collection('sessions')
      .updateMany({ origin: 'board' }, { $set: { origin: 'user' } });
    await db.collection('sessions').updateMany({}, { $unset: { board_plan_id: '' } });
    await db.collection('forum_plans').dropIndex('kind_1').catch(() => undefined);
    await db
      .collection('forum_plans')
      .updateMany({}, { $unset: { kind: '', name: '', description: '', acceptance: '', chat_session_id: '' } });
  },
};
