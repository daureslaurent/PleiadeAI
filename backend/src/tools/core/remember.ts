import { agentRepository } from '../../domain/agents/agent.repository';
import { agentMemory } from '../../domain/memory/agent-memory.service';
import { MEMORY_KINDS, type MemoryKind } from '../../domain/memory/memory.types';
import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:remember');

/**
 * Core memory-write tool. Lets an agent *deliberately* persist a salient fact into its own isolated
 * Qdrant namespace; it is embedded and becomes retrievable (auto-injected) on future turns.
 *
 * Complements the automatic post-turn distiller (`memory-distiller.ts`), which writes memories on
 * the agent's behalf: use this when the agent knows, mid-turn, that something must be kept and
 * doesn't want to leave that to the distiller's judgement. Writes go through the same dedup path,
 * so re-saving a known fact reinforces it rather than duplicating it.
 */
export const remember: Tool = {
  name: 'remember',
  description:
    'Save something to your long-term memory, written as a standalone statement that will still make sense weeks from now with no conversation around it. It is embedded and recalled automatically when relevant on future turns. Saving something you already remember simply reinforces it.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The memory, as a clear standalone statement. Name the things it refers to — never "it", "that file", "as discussed".',
      },
      kind: {
        type: 'string',
        enum: MEMORY_KINDS,
        description:
          'fact = a durable truth; preference = how the operator wants things done; procedure = a reusable how-to you learned; episode = something that happened, worth recalling later.',
      },
      subject: {
        type: 'string',
        description: 'Short lowercase key for what this is about, e.g. "gpu-broker", "operator".',
      },
      importance: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: '1 = trivia, 3 = useful, 5 = load-bearing (real harm if forgotten). Weighs recall.',
      },
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

    const kind = MEMORY_KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : 'fact';
    const id = await agentMemory.remember(agent.qdrant_namespace, {
      text: content,
      kind,
      subject: args.subject ? String(args.subject) : undefined,
      importance: typeof args.importance === 'number' ? args.importance : 3,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
      source: 'remember_tool',
    });
    if (!id) {
      return { result: { ok: false, error: 'could not store memory (embeddings unavailable?)' } };
    }

    log.info({ agentId: ctx.agentId, id, kind }, 'memory stored');
    return { result: { ok: true, id, kind, stored: content } };
  },
};
