import { agentRepository } from '../../domain/agents/agent.repository';
import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:update_notebook');

/**
 * Core mutation tool provisioned to every agent. Lets an agent maintain its own notebook — a
 * persistent Markdown scratchpad injected into its system prompt on future turns (spec §2). Use
 * `append` to jot a new note, `replace` to rewrite the whole document.
 *
 * The notebook is the *only* prompt document an agent may write. The two AGENTS.md files (the
 * fleet-wide house rules in `settings.agents_md` and the agent's own charter in `agent.agents_md`)
 * are operator-owned and deliberately have no tool behind them.
 */
export const updateNotebook: Tool = {
  name: 'update_notebook',
  description:
    "Edit your own notebook — a persistent Markdown document injected into your system prompt on future turns. Use mode 'append' to add a note to the end, or 'replace' to rewrite the whole document. Record durable conventions, learnings, and TODOs here. This is the only document you can write: the AGENTS.md instructions you were given are read-only.",
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

    const existing = (current.notebook as string | undefined) ?? '';
    const next =
      mode === 'replace' ? content : existing.trim() ? `${existing.trimEnd()}\n\n${content}` : content;

    const updated = await agentRepository.setNotebook(ctx.agentId, next);
    if (!updated) {
      return { result: { ok: false, error: 'agent not found' } };
    }

    log.info({ agentId: ctx.agentId, mode, length: next.length }, 'notebook updated');
    return { result: { ok: true, mode, notebook: next } };
  },
};
