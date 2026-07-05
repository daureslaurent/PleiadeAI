import { agentRepository } from '../../domain/agents/agent.repository';
import type { Tool } from '../types';

/**
 * Core discovery tool: the directory ("annuaire") of available agents. Meant to be consulted
 * *before* `ask_agent` so the caller can pick a delegation target by capability instead of
 * guessing a name. Returns every other *subagent*'s name, description, and allowed tools; the
 * calling agent is omitted (it can't usefully delegate to itself), as are top-level agents
 * (`subagent === false`) — those are user-facing orchestrators, not delegation targets.
 */
export const annuaire: Tool = {
  name: 'annuaire',
  description:
    'List the other agents available for delegation, with each one\'s description and tools. Consult this before ask_agent to choose the right target.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  async execute(_args, ctx) {
    const agents = await agentRepository.list();
    const others = agents
      .filter((a) => a.name !== ctx.agentName && a.subagent)
      .map((a) => ({
        agent: a.name,
        description: a.description || '',
        tools: a.tools_allowed ?? [],
      }));

    return { result: { ok: true, count: others.length, agents: others } };
  },
};
