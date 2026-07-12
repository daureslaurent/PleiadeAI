import { agentRepository } from '../../domain/agents/agent.repository';
import { agentMemory } from '../../domain/memory/agent-memory.service';
import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:forget');

/** A memory must be *this* close to the description before it's retired — no vague sweeps. */
const FORGET_THRESHOLD = 0.75;

/**
 * Core memory-retire tool. Without it, a memory that turns out to be wrong lives forever and keeps
 * being recalled alongside its own correction, and the model is handed the contradiction with no
 * way to tell which is current.
 *
 * Retiring is not deletion: the point stays in the namespace (audit trail, visible in the Memory
 * Vault) but is marked `superseded` and excluded from every future recall. Operator-facing deletion
 * remains a Vault action.
 */
export const forget: Tool = {
  name: 'forget',
  description:
    'Retire a memory you now know to be wrong or obsolete, so it stops being recalled. Describe the memory in your own words — the closest match is retired. Prefer this over silently contradicting yourself when you learn a stored fact has changed.',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'The memory to retire, described closely enough to match it (or its exact text).',
      },
    },
    required: ['description'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const description = String(args.description ?? '').trim();
    if (!description) return { result: { ok: false, error: 'description is required' } };

    const agent = await agentRepository.findById(ctx.agentId);
    if (!agent) return { result: { ok: false, error: 'agent not found' } };

    // Reuse recall's own retrieval so the agent forgets the thing it would have been shown.
    const [match] = await agentMemory.recall(agent.qdrant_namespace, description, 1);
    if (!match || match.similarity < FORGET_THRESHOLD) {
      return {
        result: {
          ok: false,
          error: 'no memory matched that description closely enough to retire',
          closest: match?.payload.text ?? null,
        },
      };
    }

    await agentMemory.supersede(agent.qdrant_namespace, String(match.id));
    log.info({ agentId: ctx.agentId, id: match.id }, 'memory retired');
    return { result: { ok: true, forgot: match.payload.text, id: String(match.id) } };
  },
};
