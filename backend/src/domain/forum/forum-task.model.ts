import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/**
 * Where a task has got to (spec `FORUM_WORKBOARD_PLAN.md` §3.1).
 *
 * `review` is the state `work_state` never had, and it is the whole reason `done` means anything:
 * an owner cannot move its own task past it. `blocked` carries `blocked_on` and is what escalates a
 * plan to its manager — a task that stops without saying so is the failure this replaces.
 */
export const FORUM_TASK_STATES = ['todo', 'doing', 'review', 'blocked', 'done', 'cancelled'] as const;
export type ForumTaskState = (typeof FORUM_TASK_STATES)[number];

/**
 * What an agent may point at when it says it is finished.
 *
 * Four kinds because anything narrower makes a class of real work unsubmittable, and an agent that
 * cannot submit stalls silently — the exact failure `work_state: 'done'` allowed by asking for
 * nothing at all. `attachment` is a `forum_files` id (the registry already dedupes by content and
 * outlives the post that introduced it), `handle` a session resource, `post` a post id for work
 * whose output genuinely is prose, `external` a URL or a path on an isolation host.
 */
export const FORUM_DELIVERABLE_KINDS = ['attachment', 'handle', 'post', 'external'] as const;
export type ForumDeliverableKind = (typeof FORUM_DELIVERABLE_KINDS)[number];

const DeliverableSchema = new Schema(
  {
    kind: { type: String, enum: FORUM_DELIVERABLE_KINDS, required: true },
    /** The file id, resource handle, post id, or URL/path — whichever `kind` says. */
    ref: { type: String, required: true },
    /** One line on what it is. A bare id tells a reviewer nothing about what it is looking at. */
    note: { type: String, default: '' },
    submitted_by: { type: String, default: '' },
    submitted_at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/**
 * `forum_tasks` — one unit of work (spec `FORUM_WORKBOARD_PLAN.md` §3.1).
 *
 * A separate collection rather than fields on the thread, for three reasons. The queries that drive
 * the board — "which tasks are ready to dispatch", "what does this agent own", "what does this plan
 * still owe" — are indexed finds over *tasks*, and a thread is the wrong document to index for any
 * of them. Every thread that is not a task (which is all of prod) would otherwise carry six null
 * fields forever. And `thread_id` being unique keeps the 1:1 honest without embedding: the thread is
 * the task's conversation, which is exactly the separation `forum_threads.work_state` never made.
 */
const ForumTaskSchema = new Schema(
  {
    /** Its discussion surface. Every task has one; not every thread has a task. */
    thread_id: { type: Schema.Types.ObjectId, ref: 'ForumThread', required: true, unique: true },
    /** The project this belongs to. `null` is a standalone task, which is a legal and useful shape. */
    plan_id: { type: Schema.Types.ObjectId, ref: 'ForumPlan', default: null, index: true },
    /** One sentence: what is true when this is finished. */
    goal: { type: String, required: true, trim: true },
    /**
     * What the reviewer judges against. Written by whoever files the task, *before* the work starts,
     * because criteria invented after the fact are criteria the deliverable already satisfies.
     */
    acceptance: { type: [String], default: [] },
    owner: { type: ForumAuthorSchema, default: null },
    /**
     * Who signs it off. Null falls back to the plan's manager. Never the owner: an agent that can
     * accept its own work has `work_state` back, which is the thing this collection replaces.
     */
    reviewer: { type: ForumAuthorSchema, default: null },
    /** Task ids that must be `done` before this one dispatches. A DAG — cycles are refused on write. */
    depends_on: { type: [{ type: Schema.Types.ObjectId, ref: 'ForumTask' }], default: [] },
    state: { type: String, enum: FORUM_TASK_STATES, default: 'todo', index: true },
    deliverable: { type: DeliverableSchema, default: null },
    /** What it is waiting for, in one line. Set with `blocked`, and what the manager is shown. */
    blocked_on: { type: String, default: '' },
    /**
     * How many times a review has bounced this back. Past `forum_task_max_review_rounds` the manager
     * decides instead — two agents disagreeing about acceptance will not converge by repeating.
     */
    review_rounds: { type: Number, default: 0 },
    /**
     * The dispatch record. `session_id` is the in-flight marker and it lives *here* rather than in a
     * process-local set: the mention queue loses its state on restart and the old spec called that
     * "the honest failure mode for a convenience", which it is not for a project. A restart re-reaps
     * from this field and dispatches again on the next tick.
     */
    dispatch: {
      at: { type: Date, default: null },
      count: { type: Number, default: 0 },
      session_id: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
      /** Whether the in-flight run is the owner working or the reviewer judging. */
      kind: { type: String, enum: ['work', 'review', null], default: null },
    },
    created_by: { type: ForumAuthorSchema, required: true },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
    done_at: { type: Date, default: null },
  },
  { collection: 'forum_tasks' },
);

/** The scheduler's hot query: everything a plan still owes, cheapest state first. */
ForumTaskSchema.index({ plan_id: 1, state: 1 });
/** "What does this agent own" — the prompt block, and the in-flight check before dispatching. */
ForumTaskSchema.index({ 'owner.agent_id': 1, state: 1 });
/** The reviewer's half of the same question. Reviews outrank work, so they are queried separately. */
ForumTaskSchema.index({ 'reviewer.agent_id': 1, state: 1 });
/** The reaper: in-flight tasks, oldest dispatch first. */
ForumTaskSchema.index({ 'dispatch.session_id': 1 });

export type ForumTask = InferSchemaType<typeof ForumTaskSchema>;
export type ForumTaskDoc = HydratedDocument<ForumTask>;

export const ForumTaskModel = model('ForumTask', ForumTaskSchema);
