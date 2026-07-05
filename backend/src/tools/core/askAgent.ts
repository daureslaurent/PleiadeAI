import type { Tool } from '../types';

/**
 * Core cross-agent tool (spec §4). Delegates a query to another agent and returns its answer.
 *
 * The actual recursion — depth increment, the `MAX_AGENT_HOPS` guard, and the `agent:ask_agent`
 * event — lives in the orchestrator's injected `invokeSubAgent`. This tool stays a thin adapter
 * so the sandbox/tool layer never imports the AgentRunner (avoids a dependency cycle).
 */
export const askAgent: Tool = {
  name: 'ask_agent',
  description:
    'Delegate a question or task to another agent by name and receive its final answer. Use for cross-domain work outside your own scope.',
  parameters: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'Target agent name, e.g. "home_coordinator".' },
      query: { type: 'string', description: 'The question or task to delegate.' },
    },
    required: ['agent', 'query'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const target = String(args.agent ?? '').trim();
    const query = String(args.query ?? '').trim();

    if (!ctx.invokeSubAgent) {
      return {
        result: {
          ok: false,
          error: 'Cross-agent hop limit reached; cannot delegate further.',
        },
      };
    }
    if (!target || !query) {
      return { result: { ok: false, error: 'agent and query are required' } };
    }

    try {
      const answer = await ctx.invokeSubAgent(target, query);
      return { result: { ok: true, agent: target, answer } };
    } catch (err) {
      return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
