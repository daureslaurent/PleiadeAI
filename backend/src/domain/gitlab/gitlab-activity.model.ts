import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * What the fleet did on GitLab (`GITLAB_PLAN.md` §4).
 *
 * Writes only. Reads are not logged — the debugger already traces every tool call, and a row per
 * `gitlab_files({action:'read'})` would bury the commits under browsing noise. What this collection
 * exists to answer is "who changed what, and out of which conversation", which is why `session_id`
 * is on every row: it turns the GitLab page's feed into links back into the Workspace, and it is the
 * one association GitLab's own events API can never carry.
 */
const GitLabActivitySchema = new Schema(
  {
    agent_id: { type: String, required: true, index: true },
    agent_name: { type: String, required: true },
    /** The conversation the call was made in — a link back into the Workspace. */
    session_id: { type: String, default: '', index: true },
    /** Full project path (`group/project`), as the agent addressed it. */
    project: { type: String, default: '', index: true },
    /** Tool + action, e.g. `gitlab_mr.merge`. */
    action: { type: String, required: true, index: true },
    /** What was acted on: an issue `#12`, an MR `!3`, a branch name, a short SHA. */
    target: { type: String, default: '' },
    /** One line for the feed — the issue title, the commit message, the branch created. */
    title: { type: String, default: '' },
    /** Straight to the thing on GitLab. */
    url: { type: String, default: '' },
    at: { type: Date, default: Date.now, index: true },
  },
  { collection: 'gitlab_activity', versionKey: false },
);

// The feed is always "newest first, optionally for one project" — the compound index serves both.
GitLabActivitySchema.index({ project: 1, at: -1 });

export type GitLabActivityDoc = InferSchemaType<typeof GitLabActivitySchema> & { _id: string };

export const GitLabActivityModel = model('GitLabActivity', GitLabActivitySchema);
