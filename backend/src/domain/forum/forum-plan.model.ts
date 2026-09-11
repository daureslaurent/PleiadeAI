import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/**
 * A plan's life (spec `FORUM_WORKBOARD_PLAN.md` §3.2).
 *
 * `draft` is load-bearing rather than ceremonial: the manager is an LLM and a bad plan dispatches
 * just as confidently as a good one, so the operator reads it before anything runs. `blocked` means
 * the scheduler has nothing it can dispatch and has handed the problem to the manager.
 */
export const FORUM_PLAN_STATES = ['draft', 'running', 'blocked', 'done', 'cancelled'] as const;
export type ForumPlanState = (typeof FORUM_PLAN_STATES)[number];

/**
 * `forum_plans` — one project (spec `FORUM_WORKBOARD_PLAN.md` §3.2).
 *
 * The dependency graph lives on the tasks (`depends_on`); this document is the project's identity,
 * its leash and its manager. `turns_spent` is the counter that matters — every dispatched agent turn,
 * work and review alike — replacing `auto_run_count` for anything under a plan. One number for the
 * whole project is the unit `FORUM_AUTORUN_PLAN.md` §E already argued for, and the one an operator
 * actually raises when a project needs more room.
 */
const ForumPlanSchema = new Schema(
  {
    /** The project's front page. Reuses the hub thread `FORUM_AUTORUN_PLAN.md` §E introduced. */
    hub_thread_id: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true, unique: true },
    /** What was asked for, verbatim where possible — the manager replans against this, not a paraphrase. */
    goal: { type: String, required: true },
    /** The agent that plans and replans. Called on exceptions only; it never dispatches anything. */
    manager: { type: ForumAuthorSchema, required: true },
    state: { type: String, enum: FORUM_PLAN_STATES, default: 'draft', index: true },
    turns_spent: { type: Number, default: 0 },
    /**
     * The leash, seeded from `settings.forum_plan_max_turns` at creation and raisable per plan. Kept
     * on the document rather than read from settings each time so raising the fleet default does not
     * silently un-stop a project the operator deliberately let run out.
     */
    turns_max: { type: Number, default: 60 },
    /** How many times the manager has revised the plan. Bounded by `forum_plan_max_revisions`. */
    revision: { type: Number, default: 0 },
    /**
     * This project's own subagent model (`BOARD_SUBAGENT_MODEL_PLAN.md`), overriding the fleet
     * setting for its *work* dispatches. Empty inherits the fleet; the fleet empty too means no
     * override at all and every turn runs on its agent's configured model.
     *
     * Read fresh on each dispatch rather than snapshotted like `turns_max`, and for the opposite
     * reason: the leash is a decision about *this* project that a later fleet change must not undo,
     * while the model is a routing choice the operator changes precisely to affect the runs still to
     * come — a project struggling on a small model should move to a bigger one mid-flight.
     */
    subagent_endpoint_id: { type: String, default: '' },
    subagent_model: { type: String, default: '' },
    /** In-flight marker for a manager turn, so a tick cannot start a second one. */
    manager_session_id: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    last_manager_at: { type: Date, default: null },
    /** Why the scheduler last escalated. Shown to the manager, and to the operator on the plan page. */
    escalation: { type: String, default: '' },
    created_by: { type: ForumAuthorSchema, required: true },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
    finished_at: { type: Date, default: null },
  },
  { collection: 'forum_plans' },
);

/** The scheduler's outer loop: every plan that may dispatch, oldest attention first. */
ForumPlanSchema.index({ state: 1, last_manager_at: 1 });

export type ForumPlan = InferSchemaType<typeof ForumPlanSchema>;
export type ForumPlanDoc = HydratedDocument<ForumPlan>;

export const ForumPlanModel = model('ForumPlan', ForumPlanSchema);
