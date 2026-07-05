import { agentRepository } from '../../domain/agents/agent.repository';
import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:update_agents_md');

/**
 * Core mutation tool provisioned to every agent. Lets an agent maintain its own AGENTS.md — a
 * persistent Markdown notebook injected into its system prompt on future turns (spec §2). Use
 * `append` to jot a new note, `replace` to rewrite the whole document.
 */
export const updateAgentsMd: Tool = {
  name: 'update_agents_md',
  description:
    "Edit your own AGENTS.md — a persistent Markdown notebook injected into your system prompt on future turns. Use mode 'append' to add a note to the end, or 'replace' to rewrite the whole document. Record durable conventions, learnings, and TODOs here.",
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Markdown content to append or the full replacement document.' },
      mode: {
        type: 'string',
        enum: ['append', 'replace'],
        description: "'append' adds to the end (default); 'replace' overwrites the whole document.",
      },
    },
    required: ['content'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const content = String(args.content ?? '');
    const mode = args.mode === 'replace' ? 'replace' : 'append';

    const current = await agentRepository.findById(ctx.agentId);
    if (!current) {
      return { result: { ok: false, error: 'agent not found' } };
    }

    const existing = (current.agents_md as string | undefined) ?? '';
    const next =
      mode === 'replace' ? content : existing.trim() ? `${existing.trimEnd()}\n\n${content}` : content;

    const updated = await agentRepository.setAgentsMd(ctx.agentId, next);
    if (!updated) {
      return { result: { ok: false, error: 'agent not found' } };
    }

    log.info({ agentId: ctx.agentId, mode, length: next.length }, 'agents.md updated');
    return { result: { ok: true, mode, agents_md: next } };
  },
};
