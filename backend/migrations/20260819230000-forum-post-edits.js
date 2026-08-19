// The moderator may now revise a post it did not write — including the operator's (FORUM_PLAN.md §9).
//
// Two halves, because the capability alone would not have unblocked it: `forum_admin` gained
// `edit_post` / `revert_post`, and the keeper's own charter told it in as many words never to do
// that, which is what it was actually obeying.
//
// The prompt edit is surgical on purpose. The operator may have rewritten the keeper's prompt since
// it was seeded, so this replaces the one paragraph by its exact text and leaves the document alone
// if it isn't there — a blanket `$set` of the whole prompt would silently discard their work.

const BUILTIN_SLUG = 'forum_moderator';

const OLD_RULE = `Never rewrite the *content* of another agent's post. You organise the board; you do not edit what
anyone said.`;

const NEW_RULE = `Do not rewrite the *substance* of anyone's post — their claims, their conclusions, their reasoning
are theirs. \`edit_post\` exists for the narrow cases where a post is wrong in a way that misleads
whoever reads it next: a broken code fence, a dead link, a wrong thread id, a mangled paste, or a
correction the author themselves asked for. Fix that, leave the rest exactly as written, and always
give a \`reason\` — it is kept on the post with the body you replaced, and \`revert_post\` undoes you.
When in doubt, reply with the correction instead of editing; a thread that shows the correction being
made is more trustworthy than one that was quietly fixed.`;

const OLD_CHARTER = `Reversible actions (move, rename, archive, merge) are yours to take. Irreversible ones are not
yours at all — propose them.`;

const NEW_CHARTER = `Reversible actions (move, rename, archive, merge, and a corrective \`edit_post\`) are yours to take.
Irreversible ones are not yours at all — propose them.`;

module.exports = {
  async up(db) {
    // Every post gains its edit history. Backfilled explicitly rather than left to the Mongoose
    // default, which only applies to documents written from here on — `revert_post` reads this field
    // on posts that predate it, and a missing array would read as "never edited" anyway, but the
    // explicit backfill keeps the collection uniform for anything that queries on it.
    await db
      .collection('forum_posts')
      .updateMany({ edits: { $exists: false } }, { $set: { edits: [] } });

    const agent = await db.collection('agents').findOne({ builtin: BUILTIN_SLUG });
    if (!agent) return;

    const patch = {};
    if (typeof agent.system_prompt === 'string' && agent.system_prompt.includes(OLD_RULE)) {
      patch.system_prompt = agent.system_prompt.replace(OLD_RULE, NEW_RULE);
    }
    if (typeof agent.agents_md === 'string' && agent.agents_md.includes(OLD_CHARTER)) {
      patch.agents_md = agent.agents_md.replace(OLD_CHARTER, NEW_CHARTER);
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date();
      await db.collection('agents').updateOne({ _id: agent._id }, { $set: patch });
    }
  },

  async down(db) {
    // The histories go, but not the bodies they were pushed from: a post edited while this was in
    // place keeps whatever it currently says. Dropping down to the previous version means losing the
    // undo, not silently reverting posts the operator may have already accepted.
    await db.collection('forum_posts').updateMany({}, { $unset: { edits: '' } });

    const agent = await db.collection('agents').findOne({ builtin: BUILTIN_SLUG });
    if (!agent) return;

    const patch = {};
    if (typeof agent.system_prompt === 'string' && agent.system_prompt.includes(NEW_RULE)) {
      patch.system_prompt = agent.system_prompt.replace(NEW_RULE, OLD_RULE);
    }
    if (typeof agent.agents_md === 'string' && agent.agents_md.includes(NEW_CHARTER)) {
      patch.agents_md = agent.agents_md.replace(NEW_CHARTER, OLD_CHARTER);
    }
    if (Object.keys(patch).length) {
      patch.updated_at = new Date();
      await db.collection('agents').updateOne({ _id: agent._id }, { $set: patch });
    }
  },
};
