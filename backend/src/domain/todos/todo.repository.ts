import { createLogger } from '../../config/logger';
import { TodoModel, TODO_STATUSES, type TodoStatus } from './todo.model';

const log = createLogger('todo-repo');

/** A checklist item as the tool hands it over — no id, the repository assigns one. */
export interface TodoItemInput {
  content: string;
  status?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Hard cap on list length. A plan longer than this is a sign the agent should be delegating. */
const MAX_ITEMS = 50;

function normalise(items: TodoItemInput[]): TodoItem[] {
  return items
    .filter((it) => String(it?.content ?? '').trim())
    .slice(0, MAX_ITEMS)
    .map((it, i) => ({
      // Positional ids: the model rewrites the whole list every time, so an id only has to be stable
      // within one snapshot (for React keys and diffing), never across writes.
      id: `t${i + 1}`,
      content: String(it.content).trim(),
      status: (TODO_STATUSES as readonly string[]).includes(String(it.status))
        ? (it.status as TodoStatus)
        : 'pending',
    }));
}

export const todoRepository = {
  /** The agent's current list for this session, or `[]` when it has never written one. */
  async get(sessionId: string, agentId: string): Promise<TodoItem[]> {
    const doc = await TodoModel.findOne({ session_id: sessionId, agent_id: agentId }).lean();
    return (doc?.items as TodoItem[] | undefined) ?? [];
  },

  /** Every list in a session, for restoring the UI on load. Newest write first. */
  async listBySession(sessionId: string) {
    return TodoModel.find({ session_id: sessionId }).sort({ updated_at: -1 }).lean();
  },

  /** Replace an agent's list wholesale (the only write path — see the plan doc on why). */
  async replace(
    sessionId: string,
    agentId: string,
    agentName: string,
    items: TodoItemInput[],
  ): Promise<TodoItem[]> {
    const normalised = normalise(items);
    await TodoModel.updateOne(
      { session_id: sessionId, agent_id: agentId },
      { $set: { agent_name: agentName, items: normalised, updated_at: new Date() } },
      { upsert: true },
    );
    log.debug({ sessionId, agentId, count: normalised.length }, 'todo list replaced');
    return normalised;
  },
};
