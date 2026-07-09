/**
 * The read-only surface of the PleiadesAI API, described once and consumed twice: the MCP server
 * turns each entry into a tool (`pleiades_<name>`), and `scripts/prod.mjs` turns each into a
 * subcommand. Adding a capability means adding one entry here.
 *
 * `args` is a flat map of argument name → { type, description, required? }. `resolve(args)` returns
 * `{ path, query }` for `apiGet`.
 */
export const ENDPOINTS = [
  {
    name: 'agents',
    description: 'List every agent, with its model, tools, isolation profile and visual capability.',
    args: {},
    resolve: () => ({ path: '/api/agents' }),
  },
  {
    name: 'agent',
    description: 'Fetch one agent by id, including its full system prompt and parameters.',
    args: { id: { type: 'string', description: 'Agent _id', required: true } },
    resolve: (a) => ({ path: `/api/agents/${a.id}` }),
  },
  {
    name: 'skills',
    description: 'List user-authored skills (TS/Python) with their enabled/disabled state.',
    args: {},
    resolve: () => ({ path: '/api/skills' }),
  },
  {
    name: 'sessions',
    description: 'List an agent\'s conversation sessions, newest first.',
    args: { agent_id: { type: 'string', description: 'Agent _id', required: true } },
    resolve: (a) => ({ path: '/api/sessions', query: { agentId: a.agent_id } }),
  },
  {
    name: 'session_messages',
    description: 'Full message history of one session — the actual conversation transcript.',
    args: { session_id: { type: 'string', description: 'Session _id', required: true } },
    resolve: (a) => ({ path: `/api/sessions/${a.session_id}/messages` }),
  },
  {
    name: 'llama_logs',
    description:
      'Recent raw inference calls (prompt, completion, timing, token counts), newest first. Use for debugging what the model actually saw.',
    args: { limit: { type: 'number', description: 'How many calls (1–1000, default 10)' } },
    resolve: (a) => ({ path: '/api/llama-logs', query: { limit: a.limit } }),
  },
  {
    name: 'llama_log',
    description: 'One inference call in full, by its call id.',
    args: { call_id: { type: 'string', description: 'The call_id from pleiades_llama_logs', required: true } },
    resolve: (a) => ({ path: `/api/llama-logs/${a.call_id}` }),
  },
  {
    name: 'llama_stats',
    description: 'Aggregate inference statistics (call volume, latency, token throughput).',
    args: {},
    resolve: () => ({ path: '/api/llama-logs/stats' }),
  },
  {
    name: 'scoring_summary',
    description: 'Distribution of judged turn quality (counts per tag, mean score) for the SFT dataset.',
    args: {},
    resolve: () => ({ path: '/api/scoring/summary' }),
  },
  {
    name: 'scores',
    description: 'Judged turns, newest first. Filter by session, tag (Perfect/Patched/Recovered/Rejected) or minimum score.',
    args: {
      session_id: { type: 'string', description: 'Restrict to one session' },
      tag: { type: 'string', description: 'Perfect | Patched | Recovered | Rejected' },
      min_score: { type: 'number', description: 'Only turns scoring at least this (0–100)' },
      limit: { type: 'number', description: 'Max rows' },
    },
    resolve: (a) => ({
      path: '/api/scoring/scores',
      query: { sessionId: a.session_id, tag: a.tag, minScore: a.min_score, limit: a.limit },
    }),
  },
  {
    name: 'inbox',
    description: 'Notifications raised by completed headless/cron tasks.',
    args: {
      unread_only: { type: 'boolean', description: 'Only unread notifications' },
      agent_id: { type: 'string', description: 'Restrict to one agent' },
    },
    resolve: (a) => ({
      path: '/api/inbox',
      query: { unread: a.unread_only ? 'true' : undefined, agentId: a.agent_id },
    }),
  },
  {
    name: 'memory',
    description: "An agent's stored Qdrant memories (its private namespace).",
    args: { agent_id: { type: 'string', description: 'Agent _id', required: true } },
    resolve: (a) => ({ path: `/api/memory/${a.agent_id}` }),
  },
  {
    name: 'autonomy_jobs',
    description: 'Scheduled cron jobs and their agents.',
    args: {},
    resolve: () => ({ path: '/api/autonomy/jobs' }),
  },
  {
    name: 'export_config',
    description:
      'Portable config bundle (agents + their isolations), with SSH keys and secret-looking parameters stripped. Importable onto another instance.',
    args: {
      agent_ids: { type: 'string', description: 'Comma-separated agent _ids. Omit to export every agent.' },
    },
    resolve: (a) => ({
      path: '/api/transfer/export/config',
      query: a.agent_ids ? { agentIds: a.agent_ids } : { all: 'true' },
    }),
  },
  {
    name: 'get',
    description:
      'Escape hatch: GET any API path directly, e.g. "/api/isolations". Use when no specific tool covers what you need.',
    args: {
      path: { type: 'string', description: 'Path beginning with /api/', required: true },
      query: { type: 'object', description: 'Optional query-string parameters' },
    },
    resolve: (a) => ({ path: a.path, query: a.query ?? {} }),
  },
];

/** Build the JSON Schema an MCP client needs to call a tool. */
export function inputSchemaOf(endpoint) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(endpoint.args)) {
    properties[name] = { type: spec.type, description: spec.description };
    if (spec.required) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
