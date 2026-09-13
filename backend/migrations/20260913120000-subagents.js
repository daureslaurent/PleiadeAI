/**
 * Subagents (`SUBAGENT_PLAN.md` §4) — an agent hands read-heavy work to fresh-context copies of itself.
 *
 * Every field defaults to "no change in where anything runs":
 *
 * - `settings.subagent_endpoint_id` / `_model: ''` — no fleet default, so a child runs on its agent's
 *   own model until the operator picks a smaller one.
 * - `settings.subagent_report_max_chars: 6000` — the most one report may be; the runner shrinks it
 *   further to what the parent's remaining context can hold.
 * - `settings.modules_disabled_subagent: []` — the subagent profile starts at each module's own
 *   `subagentDefault` (memory, forum, board, todo, auto-loop and orchestration off in a child).
 * - `agents.subagent_endpoint_id: null` / `subagent_model: ''` — every agent inherits the fleet.
 *
 * Only missing fields are written, so re-running never clobbers what an operator already chose.
 */
const SETTINGS_DEFAULTS = {
  subagent_endpoint_id: '',
  subagent_model: '',
  subagent_report_max_chars: 6000,
  modules_disabled_subagent: [],
};

module.exports = {
  async up(db) {
    const settings = (await db.collection('settings').findOne({ key: 'global' })) ?? {};
    const missing = Object.fromEntries(
      Object.entries(SETTINGS_DEFAULTS).filter(([field]) => settings[field] === undefined),
    );
    if (Object.keys(missing).length) {
      await db.collection('settings').updateOne({ key: 'global' }, { $set: missing }, { upsert: true });
    }

    await db
      .collection('agents')
      .updateMany(
        { subagent_endpoint_id: { $exists: false } },
        { $set: { subagent_endpoint_id: null, subagent_model: '' } },
      );
  },

  async down(db) {
    const unset = Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map((field) => [field, '']));
    await db.collection('settings').updateOne({ key: 'global' }, { $unset: unset });
    await db.collection('agents').updateMany({}, { $unset: { subagent_endpoint_id: '', subagent_model: '' } });
  },
};
