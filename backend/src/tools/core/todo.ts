import { createLogger } from '../../config/logger';
import { todoRepository, type TodoItemInput } from '../../domain/todos/todo.repository';
import type { Tool } from '../types';

const log = createLogger('tool:todowrite');

/**
 * `todowrite` — the agent's own working checklist for the current session (see `TODO_TOOL_PLAN.md`).
 * Auto-granted to every agent alongside `data` / `guide`.
 *
 * The call **replaces the whole list**: the agent always sends every item, with its status. That is
 * deliberate rather than lazy — granular add/complete/remove by id reads cheaper but models drift on
 * ids and half-apply partial updates, whereas a full rewrite is idempotent, needs no id bookkeeping,
 * and leaves the complete plan legible at every step of the trace.
 *
 * There is no `todoread`: the current list is injected into the agent's prompt each turn by
 * `jit-builder`, so a read tool would only re-fetch what it has already been told — including, on
 * the next turn, whatever it left `in_progress`.
 */
export const todoWrite: Tool = {
  name: 'todowrite',
  description:
    'Record or update your task list for the work you are doing. Use it for multi-step work (roughly ' +
    'three steps or more) so you do not lose track of a step mid-task: write the plan out before you ' +
    'start, then call this again after each step to update it. Skip it for simple one-shot requests — ' +
    'a checklist for trivial work is noise.\n\n' +
    'Send the COMPLETE list every time, including items already done: this call replaces your whole ' +
    'list, so any item you omit is dropped. Mark exactly one item as "in_progress" (the one you are ' +
    'working on right now) and flip it to "completed" as soon as it is done, rather than batching the ' +
    'updates at the end. Your current list is shown to you at the start of each turn.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list, in order. Replaces any previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the step is, in the imperative ("wire the route").' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: "'pending' (not started), 'in_progress' (exactly one), or 'completed'.",
            },
          },
          required: ['content'],
          additionalProperties: false,
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const raw = Array.isArray(args.todos) ? (args.todos as TodoItemInput[]) : null;
    if (!raw) {
      return { result: { ok: false, error: '`todos` must be an array of { content, status } items.' } };
    }

    const items = await todoRepository.replace(ctx.sessionId, ctx.agentId, ctx.agentName, raw);
    ctx.emitTodo?.(items);

    const done = items.filter((i) => i.status === 'completed').length;
    const active = items.filter((i) => i.status === 'in_progress');
    log.debug({ agent: ctx.agentName, count: items.length, done }, 'todo list written');

    return {
      result: {
        ok: true,
        todos: items,
        progress: `${done}/${items.length} completed`,
        // Nudge rather than reject: the list is already saved, and refusing the write over a
        // convention would cost a whole tool round-trip to fix something harmless.
        ...(active.length > 1
          ? { warning: `${active.length} items are in_progress — keep exactly one active at a time.` }
          : {}),
      },
    };
  },
};
