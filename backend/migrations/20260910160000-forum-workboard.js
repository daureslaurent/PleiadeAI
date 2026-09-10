/**
 * The work board (`FORUM_WORKBOARD_PLAN.md` §10).
 *
 * Deliberately almost a no-op on existing data. The board's whole migration story is that nothing
 * already on it changes meaning: every thread stays a thread, every post keeps its words, and a
 * thread becomes a *task* only when somebody files one. A rule applied retroactively to an archive
 * only makes the archive unreadable, which is why `kind` is written as `note` everywhere rather
 * than inferred from what a post looks like.
 *
 * Four things happen:
 *
 * 1. `forum_posts.kind = 'note'` on everything, plus the indexes the two new collections need.
 * 2. The board's settings are written as **off**, so deploying this changes no behaviour. A plan is
 *    also `draft` until started, so enabling the board later cannot set a half-read plan running.
 * 3. The retired sweep settings and the retired Agenda job are removed. Agenda would otherwise keep
 *    firing `forum:mention_sweep` from Mongo against a handler that no longer exists.
 * 4. The `project_manager` agent's charter is replaced — its previous prompt is stashed on the
 *    document first, so the change is one edit to undo. The old one teaches exactly the behaviour
 *    this plan removes: it closes every hand-off with "reply on this thread and @project_manager",
 *    which is the salutation loop written into an operator's own prompt.
 */

const MANAGER_CHARTER = `You plan projects for a fleet of agents and you do not run them. The board dispatches work by itself: when a task's dependencies are finished, its owner is woken automatically. You are called in three situations and no others — a new project goal, a plan that has hit a problem, and the operator asking for a replan.

**Planning.** Break the goal into tasks that each end in something you can point at: a file, an image, a written design, a passing check. For each task write the goal in one sentence, the acceptance criteria a different agent could judge it against without asking you, the owner, and what it depends on. Prefer four large tasks to twelve small ones; every task costs at least two agent turns. Give every task a reviewer who is not its owner.

**Acceptance criteria are the part that matters.** "Implement the parser" is not a task, it is a wish. "Parses the three sample files in \`fixtures/\` without error and rejects the malformed fourth" is a task, because the reviewer knows what to run and the owner knows when to stop.

**Replanning.** You are shown what is blocked and why. Change the plan — split the task, reassign it, drop it, add the missing dependency — and say in one paragraph what you changed and why. Do not re-explain the parts that are working.

**You never chase anybody.** Do not post to ask how something is going, do not acknowledge completed work, do not summarise the project's status unless the operator asks. The board already shows all of it. A project where you posted nothing after the plan is a project that went well.

Your tools for this are \`board\`: \`file_task\` to add a task, \`patch_task\` to reassign or re-scope one, \`list_plan\` to see where the project stands, \`finish_plan\` when the goal is met.`;

module.exports = {
  async up(db) {
    // 1. Post kinds. `note` carries no contract, so nothing already written can now be invalid.
    await db.collection('forum_posts').updateMany({ kind: { $exists: false } }, { $set: { kind: 'note' } });
    await db.collection('forum_posts').createIndex({ kind: 1 });

    await db.collection('forum_tasks').createIndex({ thread_id: 1 }, { unique: true });
    await db.collection('forum_tasks').createIndex({ plan_id: 1, state: 1 });
    await db.collection('forum_tasks').createIndex({ 'owner.agent_id': 1, state: 1 });
    await db.collection('forum_tasks').createIndex({ 'reviewer.agent_id': 1, state: 1 });
    await db.collection('forum_tasks').createIndex({ 'dispatch.session_id': 1 });
    await db.collection('forum_plans').createIndex({ hub_thread_id: 1 }, { unique: true });
    await db.collection('forum_plans').createIndex({ state: 1, last_manager_at: 1 });

    // 2. Off, so the deploy changes nothing. Turning the board on with no plans filed does nothing
    //    at all either — which is the property that makes it safe to enable and then walk away.
    await db.collection('settings').updateMany(
      {},
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
          forum_post_contract_enabled: true,
        },
      },
    );

    // 3. The retired mechanism. The Agenda row goes too, or the scheduler keeps firing a job whose
    //    handler was deleted with `forum-sweeper.ts`.
    await db.collection('settings').updateMany(
      {},
      {
        $unset: {
          forum_sweep_enabled: '',
          forum_sweep_interval_minutes: '',
          forum_sweep_min_age_minutes: '',
          forum_sweep_max_age_hours: '',
          forum_bare_mention_summons: '',
          forum_mention_max_chain: '',
          forum_mention_max_per_pair: '',
        },
      },
    );
    await db.collection('agenda_jobs').deleteMany({ name: 'forum:mention_sweep' });

    // 4. The manager's charter. Only when the agent exists and has not already been converted —
    //    re-running a migration must not stash the new prompt as though it were the old one.
    const pm = await db.collection('agents').findOne({ name: 'project_manager' });
    if (pm && !pm.prompt_before_workboard) {
      await db.collection('agents').updateOne(
        { _id: pm._id },
        {
          $set: {
            prompt_before_workboard: pm.system_prompt ?? '',
            system_prompt: MANAGER_CHARTER,
          },
          // The board is how it works now, so it needs the tool. Idempotent: `$addToSet`.
          $addToSet: { tools_allowed: { $each: ['board', 'forum'] } },
        },
      );
    }
  },

  async down(db) {
    await db.collection('forum_posts').updateMany({}, { $unset: { kind: '', meta: '' } });
    await db.collection('settings').updateMany(
      {},
      {
        $unset: {
          forum_board_enabled: '',
          forum_tick_interval_minutes: '',
          forum_max_parallel: '',
          forum_task_max_dispatches: '',
          forum_task_max_review_rounds: '',
          forum_plan_max_turns: '',
          forum_plan_max_revisions: '',
          forum_project_manager_agent: '',
          forum_post_contract_enabled: '',
        },
        $set: {
          forum_sweep_enabled: false,
          forum_sweep_interval_minutes: 5,
          forum_sweep_min_age_minutes: 5,
          forum_sweep_max_age_hours: 12,
          forum_bare_mention_summons: false,
          forum_mention_max_chain: 4,
          forum_mention_max_per_pair: 2,
        },
      },
    );
    // The tasks and plans themselves are left in place: dropping them would destroy the record of
    // work that actually happened, and they are inert without the code that reads them.
    const pm = await db.collection('agents').findOne({ name: 'project_manager' });
    if (pm && pm.prompt_before_workboard) {
      await db.collection('agents').updateOne(
        { _id: pm._id },
        { $set: { system_prompt: pm.prompt_before_workboard }, $unset: { prompt_before_workboard: '' } },
      );
    }
  },
};
