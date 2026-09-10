import type { PromptContext, PromptModule } from '../types';

/**
 * Render the agent's local KV parameter store as a Markdown block prepended to the system
 * prompt (spec §2). This gives the agent automated visibility over its own configuration
 * (e.g. `ssh_target`) which it can mutate via `set_agent_parameter`.
 */
export function renderParameterBlock(parameters: Map<string, string>): string {
  if (!parameters || parameters.size === 0) {
    return '## Local Parameters\n_(none set)_';
  }
  const rows = [...parameters.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `- \`${k}\`: ${v}`)
    .join('\n');
  return `## Local Parameters\nThese are your persistent configuration values. Use \`set_agent_parameter\` to change them.\n${rows}`;
}

/**
 * Render the fleet-wide AGENTS.md (`settings.agents_md`) as a "House rules" block. Operator-owned
 * standing instructions that bind *every* agent, subagents included. No tool can write it — the
 * agent may only read it. Empty → omitted entirely rather than advertised as blank.
 */
export function renderHouseRulesBlock(houseRules: string | undefined): string {
  const body = (houseRules ?? '').trim();
  if (!body) return '';
  return `## House rules\nStanding instructions for every agent in this fleet. You cannot edit them; follow them.\n\n${body}`;
}

/**
 * Render this agent's own AGENTS.md — its operator-authored charter. Like the house rules it is
 * read-only to the agent: it exists so standing instructions survive whatever the agent later
 * writes into its `notebook`. Empty → omitted (a blank charter is not worth prompt tokens).
 */
export function renderAgentsMdBlock(agentsMd: string | undefined): string {
  const body = (agentsMd ?? '').trim();
  if (!body) return '';
  return `## AGENTS.md\nYour operator's standing instructions for you. You cannot edit them; follow them.\n\n${body}`;
}

export const parametersModule: PromptModule = {
  id: 'parameters',
  name: 'Local parameters',
  description: "The agent's own KV configuration store, visible to it and writable by it.",
  group: 'operator',
  tools: ['set_agent_parameter'],
  blocks: [
    {
      title: 'Local Parameters',
      placement: 'system_head',
      order: 20,
      render: (ctx: PromptContext) => renderParameterBlock(ctx.agent.parameters as Map<string, string>),
    },
  ],
};

export const houseRulesModule: PromptModule = {
  id: 'house-rules',
  name: 'House rules',
  description: 'The fleet-wide AGENTS.md every agent inherits, subagents included.',
  group: 'operator',
  settingsKeys: ['agents_md'],
  blocks: [
    {
      title: 'House rules',
      placement: 'system_head',
      order: 30,
      render: (ctx: PromptContext) => renderHouseRulesBlock(ctx.houseRules),
    },
  ],
};

export const agentsMdModule: PromptModule = {
  id: 'agents-md',
  name: 'AGENTS.md',
  description: "Each agent's own operator-authored charter, read-only to the agent.",
  group: 'operator',
  blocks: [
    {
      title: 'AGENTS.md',
      placement: 'system_head',
      order: 40,
      render: (ctx: PromptContext) => renderAgentsMdBlock(ctx.agent.agents_md as string | undefined),
    },
  ],
};
