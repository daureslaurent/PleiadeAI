import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** Lifecycle of a single checklist item. Exactly one item should be `in_progress` at a time. */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

const TodoItemSchema = new Schema(
  {
    /** Stable within a list, assigned server-side from position — the model never supplies ids. */
    id: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: String, enum: TODO_STATUSES, default: 'pending' },
  },
  { _id: false },
);

/**
 * `todos` collection — one checklist per (session, agent), the agent's own working plan for a
 * multi-step task (see `TODO_TOOL_PLAN.md`).
 *
 * Keyed per *agent* rather than per session: a delegated sub-agent maintains its own plan, which
 * renders inside its `ask_agent` bubble, and a full-list rewrite by a delegate can never wipe the
 * orchestrator's list. Session-scoped persistence (like the `resources` pool) is what lets an
 * unfinished item survive a turn boundary — which is the whole point, since the next turn's prompt
 * shows the agent what it left running.
 */
const TodoSchema = new Schema(
  {
    /** Chat session the list belongs to (matches `ToolContext.sessionId`). */
    session_id: { type: String, required: true, index: true },
    /** Agent that owns it (matches `ToolContext.agentId`). */
    agent_id: { type: String, required: true },
    /** Denormalised for display, so the UI can label a bubble's list without an agent lookup. */
    agent_name: { type: String, default: '' },
    items: { type: [TodoItemSchema], default: [] },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'todos' },
);

// One list per agent per session — `replace` upserts against this.
TodoSchema.index({ session_id: 1, agent_id: 1 }, { unique: true });

export type Todo = InferSchemaType<typeof TodoSchema>;
export type TodoDoc = HydratedDocument<Todo>;

export const TodoModel = model('Todo', TodoSchema);
