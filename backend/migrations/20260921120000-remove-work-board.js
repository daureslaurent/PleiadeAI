// The work board is gone: `forum_tasks`, `forum_plans`, `forum_plan_proposals`, the `board` tool,
// the board module, the scheduler and the `/api/board` routes all went with it. The forum stays —
// threads, posts, mentions, files and their moderation are untouched.
//
// What is left behind without this is not inert. `forum:board_tick` is persisted in `agenda_jobs`,
// so a deploy that drops its handler keeps firing it and failing every couple of minutes; a session
// still carrying `origin: 'board'` no longer matches the schema enum and renders as nothing; and the
// board's settings keys stay on the singleton where the next release's Settings page would show
// them. Each of those is removed here rather than left for whoever notices first.
//
// The three collections are dropped last, and only after the references to them are gone.

const BOARD_SETTINGS = [
  'forum_board_enabled',
  'forum_tick_interval_minutes',
  'forum_max_parallel',
  'forum_task_max_dispatches',
  'forum_task_max_review_rounds',
  'forum_plan_max_turns',
  'forum_plan_max_revisions',
  'forum_project_manager_agent',
  'forum_subagent_endpoint_id',
  'forum_subagent_model',
];

module.exports = {
  async up(db) {
    // The board's clock. Agenda re-reads its schedule from Mongo, so the row has to go, not just the
    // handler. `agenda.setup.ts` cancels it at boot too — this covers an instance that never boots
    // the old build again.
    await db.collection('agenda_jobs').deleteMany({ name: 'forum:board_tick' });

    // A board item's PM conversation is an ordinary conversation with an agent; keep it and its
    // messages, just detached from the item that started it. Deleting them would throw away real
    // transcripts to tidy up a field.
    await db.collection('sessions').updateMany({ origin: 'board' }, { $set: { origin: 'user' } });
    await db.collection('sessions').dropIndex('board_plan_id_1').catch(() => undefined);
    await db.collection('sessions').updateMany({}, { $unset: { board_plan_id: '' } });
    // `source: 'board'` marked a brief the board wrote into that conversation. The text stays; only
    // the marker that drew it as a system line goes, so it reads as an ordinary user turn.
    await db.collection('messages').updateMany({ source: 'board' }, { $unset: { source: '' } });

    await db.collection('settings').updateOne(
      { key: 'global' },
      { $unset: Object.fromEntries(BOARD_SETTINGS.map((k) => [k, ''])) },
    );
    // `modules_disabled` holds ids flipped away from their default, so the board's id sat in it
    // whenever the module was ON. An id no build knows about is inert (`state.service.ts` ignores
    // it), but leaving it there means the list no longer describes anything.
    await db
      .collection('settings')
      .updateOne(
        { key: 'global' },
        { $pull: { modules_disabled: 'board', modules_disabled_subagent: 'board' } },
      );
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: { 'module_overrides.board': '' } });

    // `board:write` unlocked `/api/board`, which no longer exists. A key keeping it would grant
    // nothing, but the Keys page validates against `API_KEY_SCOPES` and would show an unknown row.
    await db.collection('api_keys').updateMany({ scopes: 'board:write' }, { $pull: { scopes: 'board:write' } });

    // Agents still hold `board` in `tools_allowed`; `resolveTools` drops an unknown name silently,
    // but the Agents page lists it as a tool that cannot be found.
    await db.collection('agents').updateMany({ tools_allowed: 'board' }, { $pull: { tools_allowed: 'board' } });

    for (const name of ['forum_plan_proposals', 'forum_tasks', 'forum_plans']) {
      await db.collection(name).drop().catch(() => undefined);
    }
  },

  // Irreversible by construction: the tasks, plans and proposals are deleted, and nothing records
  // what they were. Re-creating the settings keys at their defaults is all that can honestly be
  // restored, and it is what makes rolling back to the previous build boot cleanly.
  async down(db) {
    await db.collection('settings').updateOne(
      { key: 'global' },
      {
        $set: {
          forum_board_enabled: false,
          forum_tick_interval_minutes: 2,
          forum_max_parallel: 1,
          forum_task_max_dispatches: 3,
          forum_task_max_review_rounds: 2,
          forum_plan_max_turns: 60,
          forum_plan_max_revisions: 6,
          forum_project_manager_agent: '',
          forum_subagent_endpoint_id: '',
          forum_subagent_model: '',
        },
      },
    );
    await db.collection('sessions').updateMany({}, { $set: { board_plan_id: null } });
    await db.collection('sessions').createIndex({ board_plan_id: 1 });
  },
};
