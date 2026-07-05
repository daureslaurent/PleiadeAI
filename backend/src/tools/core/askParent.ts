import type { Tool } from '../types';

/**
 * Core back-channel tool. Lets a delegated sub-agent ask the agent that delegated to it a
 * clarifying question and receive its answer. The recursion — depth guard, the `agent:ask_agent`
 * event, and re-running the caller with its original context — lives in the orchestrator's injected
 * `askParent`. This tool stays a thin adapter so the tool layer never imports the AgentRunner.
 *
 * Only exposed on a delegated run (the caller is another agent); a directly-addressed top-level
 * agent has no parent, so `ctx.askParent` is absent and the tool isn't offered.
 */
export const askParent: Tool = {
  name: 'ask_parent',
  description:
    'Ask the agent that delegated this task to you a clarifying question, and receive its answer. Use when you need a decision or missing information from your caller before you can continue.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to put to your caller.' },
    },
    required: ['question'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const question = String(args.question ?? '').trim();

    if (!ctx.askParent) {
      return {
        result: { ok: false, error: 'You have no parent to ask — you were not delegated this task.' },
      };
    }
    if (!question) {
      return { result: { ok: false, error: 'question is required' } };
    }

    try {
      const answer = await ctx.askParent(question);
      return { result: { ok: true, answer } };
    } catch (err) {
      return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
