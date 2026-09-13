import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * A change set the manager suggested in its chat with the operator (`BOARD_REFACTOR_PLAN.md` §6–7).
 *
 * The PM chat is where the operator asks for things in prose, and prose is exactly where an LLM is
 * most confidently wrong about what it was asked. So a chat turn never writes to the board: it files
 * one of these, the operator reads it as a list of concrete edits, and ticks the ones that stand.
 * The board's *own* manager turns (first plan, escalations) keep writing directly — the draft state
 * and the scheduler's diagnosis already are their review.
 */
export const FORUM_PROPOSAL_STATES = ['pending', 'applied', 'partial', 'rejected', 'superseded'] as const;
export type ForumProposalState = (typeof FORUM_PROPOSAL_STATES)[number];

export const FORUM_PROPOSAL_OPS = ['add_task', 'patch_task', 'cancel_task', 'patch_plan'] as const;
export type ForumProposalOpKind = (typeof FORUM_PROPOSAL_OPS)[number];

export const FORUM_PROPOSAL_OP_STATES = ['pending', 'applied', 'rejected', 'failed'] as const;
export type ForumProposalOpState = (typeof FORUM_PROPOSAL_OP_STATES)[number];

const ProposalOpSchema = new Schema(
  {
    op_id: { type: String, required: true },
    op: { type: String, enum: FORUM_PROPOSAL_OPS, required: true },
    /**
     * `add_task` only: a handle (`new1`) later ops in the same proposal may put in `depends_on`,
     * because the task it names has no id until the operator applies it.
     */
    ref: { type: String, default: '' },
    /** `patch_task` / `cancel_task`: the existing task. `add_task`: the id it got once applied. */
    task_id: { type: String, default: '' },
    /**
     * The edit itself: `goal`, `acceptance`, `owner`, `reviewer`, `depends_on` for tasks; `name`,
     * `description`, `acceptance` for `patch_plan`. Validated when proposed, applied verbatim.
     */
    args: { type: Schema.Types.Mixed, default: {} },
    /** One line from the manager on why — what the operator reads next to the checkbox. */
    why: { type: String, default: '' },
    status: { type: String, enum: FORUM_PROPOSAL_OP_STATES, default: 'pending' },
    error: { type: String, default: '' },
  },
  { _id: false },
);

const ForumProposalSchema = new Schema(
  {
    plan_id: { type: Schema.Types.ObjectId, ref: 'ForumPlan', required: true, index: true },
    session_id: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    run_id: { type: String, default: '' },
    summary: { type: String, default: '' },
    ops: { type: [ProposalOpSchema], default: [] },
    state: { type: String, enum: FORUM_PROPOSAL_STATES, default: 'pending' },
    created_at: { type: Date, default: () => new Date() },
    decided_at: { type: Date, default: null },
  },
  { collection: 'forum_plan_proposals' },
);

/** "The live proposal for this plan", and the history newest first. */
ForumProposalSchema.index({ plan_id: 1, state: 1, created_at: -1 });

export type ForumProposal = InferSchemaType<typeof ForumProposalSchema>;
export type ForumProposalDoc = HydratedDocument<ForumProposal>;

export const ForumProposalModel = model('ForumProposal', ForumProposalSchema);
