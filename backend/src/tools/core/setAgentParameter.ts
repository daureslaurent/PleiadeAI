import { agentRepository } from '../../domain/agents/agent.repository';
import { createLogger } from '../../config/logger';
import type { Tool } from '../types';

const log = createLogger('tool:set_agent_parameter');

/**
 * Core mutation tool (spec §2) provisioned to every agent. Persists a KV pair into the
 * agent's `parameters` map in MongoDB, taking effect on the next JIT prompt assembly.
 */
export const setAgentParameter: Tool = {
  name: 'set_agent_parameter',
  description:
    'Persist a key/value into your own local parameter store. The value is saved permanently and injected into your system prompt on future turns.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Parameter name, e.g. "ssh_target".' },
      value: { type: 'string', description: 'Parameter value to store.' },
    },
    required: ['key', 'value'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const key = String(args.key ?? '').trim();
    const value = String(args.value ?? '');
    if (!key) {
      return { result: { ok: false, error: 'key is required' } };
    }

    const updated = await agentRepository.setParameter(ctx.agentId, key, value);
    if (!updated) {
      return { result: { ok: false, error: 'agent not found' } };
    }

    log.info({ agentId: ctx.agentId, key }, 'parameter updated');
    return { result: { ok: true, key, value } };
  },
};
