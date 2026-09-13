import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:task');

/**
 * Hand a piece of this agent's own work to a subagent — a fresh copy of the same agent — and get
 * back only its report (`SUBAGENT_PLAN.md`).
 *
 * The point is the parent's context, not the tokens: a child can spend thirty thousand of them
 * reading files and fetching pages, and the parent receives a report capped to what it can afford.
 * The child starts from nothing but `prompt`, which is why the schema insists the brief stand alone.
 *
 * `explore` children are read-only and declared parallel-safe, so several issued in one reply run at
 * once — as many as the subagent endpoint's Parallel streams admit, one after another when that is 1.
 * A `work` child holds the agent's full toolset and always runs alone: two children editing the same
 * file at the same time is a race nobody can see until it has lost work.
 *
 * The recursion, the model override, the concurrency limit and the report cap all live in the
 * orchestrator's injected `invokeTask`; this stays a thin adapter so the tool layer never imports the
 * runner (the same shape as `ask_agent`).
 */
export const task: Tool = {
  name: 'task',
  description:
    'Delegate a self-contained piece of your own work to a subagent — a fresh copy of you with an ' +
    'empty context — and receive only its final report. Use it for broad, read-heavy work whose ' +
    'answer is short (surveying a codebase, researching several sources, digging through logs), so ' +
    'the raw material never fills your own context. Independent tasks issued together in one reply ' +
    'run in parallel. The subagent sees NOTHING of this conversation: `prompt` must contain every ' +
    'fact, path, constraint and the exact shape of the report you want back.',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'A 3–7 word label for the task, shown to the operator (e.g. "Map the auth middleware").',
      },
      prompt: {
        type: 'string',
        description:
          'The complete brief. State the goal, everything the subagent needs to know (it has no access ' +
          'to this conversation), where to look, what is out of scope, and what the report must contain.',
      },
      mode: {
        type: 'string',
        enum: ['explore', 'work'],
        description:
          '`explore` (default): read-only tools — reading, searching, fetching; runs in parallel with ' +
          'other explore tasks. `work`: your full toolset, allowed to change things; runs on its own, ' +
          'never alongside another task.',
      },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },

  // Explore children only read, so a batch of them may overlap; a `work` child may write and is kept
  // alone. How many overlap is decided later by the endpoint's slots, not here.
  parallelSafe: (args) => String(args.mode ?? 'explore') !== 'work',

  async execute(args, ctx) {
    const description = String(args.description ?? '').trim();
    const prompt = String(args.prompt ?? '').trim();
    const mode = String(args.mode ?? 'explore') === 'work' ? 'work' : 'explore';

    if (!ctx.invokeTask) {
      return {
        result: {
          ok: false,
          error: 'Subagents are not available here — a subagent cannot start subagents of its own.',
        },
      };
    }
    if (!description || !prompt) {
      return { result: { ok: false, error: 'description and prompt are required' } };
    }

    log.info({ agent: ctx.agentName, mode, description }, 'task delegating');
    try {
      const out = await ctx.invokeTask({ description, prompt, mode });
      return { result: { ok: true, description, mode, ...out } };
    } catch (err) {
      return { result: { ok: false, description, mode, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
