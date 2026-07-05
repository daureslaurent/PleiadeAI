import type { Tool } from '../types';

/**
 * Core human-in-the-loop tool. Any agent can ask the operator a question and block until they
 * answer in the UI (opencode-style). The request/response plumbing — id issuance, the modal event,
 * and the pending-promise registry — lives in the orchestrator-injected `askUser` (backed by the
 * WS `AskUserBroker`). This tool stays a thin adapter so the tool layer never imports the transport.
 */
export const askUser: Tool = {
  name: 'ask_user',
  description:
    'Ask the human operator a question and wait for their typed answer. Use only when a decision or piece of information can come solely from the user. Blocks the run until they respond.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to show the operator.' },
    },
    required: ['question'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const question = String(args.question ?? '').trim();

    if (!ctx.askUser) {
      return { result: { ok: false, error: 'The user cannot be reached from this context.' } };
    }
    if (!question) {
      return { result: { ok: false, error: 'question is required' } };
    }

    try {
      const answer = await ctx.askUser(question);
      return { result: { ok: true, answer } };
    } catch (err) {
      return { result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  },
};
