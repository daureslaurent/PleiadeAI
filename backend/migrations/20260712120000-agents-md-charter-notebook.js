// Split the single `agents_md` document (one doc, two writers) into an operator-owned charter and an
// agent-owned notebook.
//
//   agent.agents_md   — was: notebook the agent rewrote via `update_agents_md`.
//                       now: the operator's read-only AGENTS.md charter for that agent.
//   agent.notebook    — new: the agent's own scratchpad, written by the renamed `update_notebook`.
//   settings.agents_md— new: fleet-wide AGENTS.md house rules, injected into every agent read-only.
//
// Existing `agents_md` content was written *by the agents*, so it moves to `notebook`; the charter
// starts empty for the operator to author. `tools_allowed` entries are rewritten to the new tool name.

module.exports = {
  async up(db) {
    const agents = db.collection('agents');
    // Existing notes belong to the agent → move them to the notebook, then start the charter empty.
    // Guarded on `notebook` being absent (and the charter fill on `agents_md` being absent) so a
    // re-run is a no-op: an unguarded $rename would move the now-empty charter over a notebook the
    // agent has since written and destroy it.
    await agents.updateMany(
      { agents_md: { $exists: true }, notebook: { $exists: false } },
      { $rename: { agents_md: 'notebook' } },
    );
    await agents.updateMany({ agents_md: { $exists: false } }, { $set: { agents_md: '' } });
    await agents.updateMany({ notebook: { $exists: false } }, { $set: { notebook: '' } });

    // The tool an agent may call is now `update_notebook`; a stale name silently drops out of the
    // agent's toolset at resolve time, so rewrite every grant.
    await agents.updateMany(
      { tools_allowed: 'update_agents_md' },
      { $set: { 'tools_allowed.$[el]': 'update_notebook' } },
      { arrayFilters: [{ el: 'update_agents_md' }] },
    );

    await db
      .collection('settings')
      .updateMany({ agents_md: { $exists: false } }, { $set: { agents_md: '' } });
  },

  async down(db) {
    const agents = db.collection('agents');
    await agents.updateMany(
      { tools_allowed: 'update_notebook' },
      { $set: { 'tools_allowed.$[el]': 'update_agents_md' } },
      { arrayFilters: [{ el: 'update_notebook' }] },
    );
    // Restore the merged document: the notebook was the pre-split `agents_md`. Any charter the
    // operator authored after the split has no home in the old schema and is dropped.
    await agents.updateMany({}, { $unset: { agents_md: '' } });
    await agents.updateMany({ notebook: { $exists: true } }, { $rename: { notebook: 'agents_md' } });

    await db.collection('settings').updateMany({}, { $unset: { agents_md: '' } });
  },
};
