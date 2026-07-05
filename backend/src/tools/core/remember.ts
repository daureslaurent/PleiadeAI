import { agentRepository } from '../../domain/agents/agent.repository';
import { agentMemory } from '../../domain/memory/agent-memory.service';
import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:remember');

/**
 * Core memory-write tool. Lets an agent deliberately persist a salient fact into its own isolated
 * Qdrant namespace; it is embedded and becomes retrievable (auto-injected) on future turns.
 * Distinct from the passive per-turn auto-storage — use this for facts worth remembering verbatim.
 */
export const remember: Tool = {
  name: 'remember',
  description:
    'Save an important fact to your long-term memory. It is embedded and will be recalled automatically when relevant on future turns. Use for durable facts, preferences, and outcomes worth keeping.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact to remember, written as a clear standalone statement.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional labels to categorise this memory.',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const content = String(args.content ?? '').trim();
    if (!content) return { result: { ok: false, error: 'content is required' } };

    const agent = await agentRepository.findById(ctx.agentId);
    if (!agent) return { result: { ok: false, error: 'agent not found' } };

    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const id = await agentMemory.remember(agent.qdrant_namespace, content, {
      source: 'remember_tool',
      tags,
    });
    if (!id) {
      return { result: { ok: false, error: 'could not store memory (embeddings unavailable?)' } };
    }

    log.info({ agentId: ctx.agentId, id }, 'memory stored');
    return { result: { ok: true, id, stored: content } };
  },
};
