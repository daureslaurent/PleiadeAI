/**
 * The surface of the PleiadesAI API, described once and consumed twice: the MCP server turns each
 * entry into a tool (`pleiades_<name>`), and `scripts/prod.mjs` turns each into a subcommand.
 * Adding a capability means adding one entry here.
 *
 * `args` is a flat map of argument name → { type, description, required? }. `resolve(args)` returns
 * `{ path, query?, body? }`, sent with the entry's `method` (default `GET`).
 *
 * Entries with a non-GET method need an API key carrying the matching write scope — see
 * `WRITE_SCOPES` in the backend's `middleware/auth.ts`. They are marked `write: true` so both
 * front-ends can flag them.
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

  // --- Flows (FLOWS_PLAN.md). Reads first; the writes are further down. ---
  {
    name: 'flows',
    description: 'List saved flows (operator-authored node graphs the backend runs in a fixed order).',
    args: {},
    resolve: () => ({ path: '/api/flows' }),
  },
  {
    name: 'flow',
    description:
      "One flow in full: its nodes, edges, declared inputs, and any validation issues. `runnable` says whether it would start. Read this before editing — an update replaces the whole graph.",
    args: { id: { type: 'string', description: 'Flow _id', required: true } },
    resolve: (a) => ({ path: `/api/flows/${a.id}` }),
  },
  {
    name: 'flow_node_types',
    description:
      'The catalogue of node types a flow may contain: each one\'s input/output ports with their types, and its config fields (with database-backed options already resolved — the agents, tools and ComfyUI workflows that actually exist). Read this before authoring a graph; it is the only reliable source for valid node types, port names and config keys.',
    args: {},
    resolve: () => ({ path: '/api/flows/node-types' }),
  },
  {
    name: 'flow_runs',
    description: 'Run history, newest first. Omit flow_id for every flow.',
    args: {
      flow_id: { type: 'string', description: 'Restrict to one flow' },
      limit: { type: 'number', description: 'Max rows (default 50)' },
    },
    resolve: (a) => ({ path: '/api/flows/runs/list', query: { flowId: a.flow_id, limit: a.limit } }),
  },
  {
    name: 'flow_run',
    description:
      "One run in full: per-node status and timing, the produced artifacts, and the debug trace (node output, the agent's reasoning, each tool call). This is where to look when a flow did the wrong thing.",
    args: { run_id: { type: 'string', description: 'Run _id, from pleiades_flow_runs', required: true } },
    resolve: (a) => ({ path: `/api/flows/runs/${a.run_id}` }),
  },

  // --- Writes. Each needs an API key with the matching scope. ---
  {
    name: 'create_agent',
    description:
      'Create an agent. Body is the full agent document: name, description, system_prompt, tools_allowed[], qdrant_namespace, subagent, agents_md, notebook, isolation_id, isolation_volume_mode, max_tool_iterations, color, icon. Needs the "agents:write" scope.',
    method: 'POST',
    write: true,
    args: { body: { type: 'object', description: 'The agent document', required: true } },
    resolve: (a) => ({ path: '/api/agents', body: a.body }),
  },
  {
    name: 'update_agent',
    description:
      'Patch an existing agent. Body holds only the fields to change. Needs the "agents:write" scope.',
    method: 'PATCH',
    write: true,
    args: {
      id: { type: 'string', description: 'Agent _id', required: true },
      body: { type: 'object', description: 'Partial agent document', required: true },
    },
    resolve: (a) => ({ path: `/api/agents/${a.id}`, body: a.body }),
  },
  {
    name: 'create_isolation',
    description:
      'Create an isolation profile (Docker execution policy agents are assigned to). Body: name, description, image_id, network (host|bridge|none|vpn|ssh), cpus, memory, idle_timeout_ms. Needs the "isolations:write" scope.',
    method: 'POST',
    write: true,
    args: { body: { type: 'object', description: 'The isolation document', required: true } },
    resolve: (a) => ({ path: '/api/isolations', body: a.body }),
  },
  {
    name: 'android_devices',
    description:
      'List the registered Android devices (emulators / phones reachable over adb TCP/IP) an agent can be linked to.',
    args: {},
    resolve: () => ({ path: '/api/android-devices' }),
  },
  {
    name: 'create_android_device',
    description:
      'Create an Android device. Body: name, adb_host, adb_port (default 5555), description, mirror_max_size, mirror_bit_rate, mirror_max_fps, enabled. `adb_host` is resolved from inside the *agent container*, so 127.0.0.1 only works on a host-network profile. Needs the "android:write" scope.',
    method: 'POST',
    write: true,
    args: { body: { type: 'object', description: 'The device document', required: true } },
    resolve: (a) => ({ path: '/api/android-devices', body: a.body }),
  },
  {
    name: 'update_android_device',
    description:
      'Patch a registered Android device. Body holds only the fields to change. Needs the "android:write" scope.',
    method: 'PATCH',
    write: true,
    args: {
      id: { type: 'string', description: 'Device _id', required: true },
      body: { type: 'object', description: 'Partial device document', required: true },
    },
    resolve: (a) => ({ path: `/api/android-devices/${a.id}`, body: a.body }),
  },
  {
    name: 'test_android_device',
    description:
      'Complete an adb handshake against a registered device and record the verdict. Advisory: it runs from the backend container, not the agent\'s. Needs the "android:write" scope.',
    method: 'POST',
    write: true,
    args: { id: { type: 'string', description: 'Device _id', required: true } },
    resolve: (a) => ({ path: `/api/android-devices/${a.id}/test` }),
  },

  // --- Flow writes. All need the "flows:write" scope, running included: a run spends real GPU time
  //     and can drive agents, so it is not something a read-only key may trigger.
  {
    name: 'create_flow',
    description:
      'Create an empty flow. Body: name (required, unique), description, enabled. Add its graph afterwards with pleiades_update_flow. Needs the "flows:write" scope.',
    method: 'POST',
    write: true,
    args: { body: { type: 'object', description: 'The flow document: { name, description?, enabled? }', required: true } },
    resolve: (a) => ({ path: '/api/flows', body: a.body }),
  },
  {
    name: 'update_flow',
    description:
      'Update a flow. Body holds only the fields to change: name, description, enabled, nodes[], edges[]. ' +
      'Passing `nodes` or `edges` REPLACES that whole array — read the flow first and send the full list, ' +
      'not a delta. A node is { id, type, label, position:{x,y}, config:{} }; an edge is ' +
      '{ id, source, source_port, target, target_port }. The response carries `issues` and `runnable`, ' +
      'so check it rather than assuming the graph is valid. Needs the "flows:write" scope.',
    method: 'PUT',
    write: true,
    args: {
      id: { type: 'string', description: 'Flow _id', required: true },
      body: { type: 'object', description: 'Partial flow document', required: true },
    },
    resolve: (a) => ({ path: `/api/flows/${a.id}`, body: a.body }),
  },
  {
    name: 'delete_flow',
    description:
      'Delete a flow, along with its run history and the artifacts those runs produced. Needs the "flows:write" scope.',
    method: 'DELETE',
    write: true,
    args: { id: { type: 'string', description: 'Flow _id', required: true } },
    resolve: (a) => ({ path: `/api/flows/${a.id}` }),
  },
  {
    name: 'duplicate_flow',
    description:
      'Copy a flow (graph and all) under a new name. The safe way to try a variant. Needs the "flows:write" scope.',
    method: 'POST',
    write: true,
    args: { id: { type: 'string', description: 'Flow _id to copy', required: true } },
    resolve: (a) => ({ path: `/api/flows/${a.id}/duplicate` }),
  },
  {
    name: 'validate_flow',
    description:
      'Check a graph without saving it: port type compatibility, dangling {{refs}}, cycles, unpaired loops, ' +
      'missing required inputs. Send the nodes and edges you intend to save. Mutates nothing, but it is a ' +
      'POST, so it still needs the "flows:write" scope.',
    method: 'POST',
    write: true,
    args: {
      nodes: { type: 'array', description: 'The nodes to check', required: true },
      edges: { type: 'array', description: 'The edges to check', required: true },
    },
    resolve: (a) => ({ path: '/api/flows/validate', body: { nodes: a.nodes, edges: a.edges } }),
  },
  {
    name: 'run_flow',
    description:
      'Start a flow and return its run id immediately — it does NOT wait, because a flow with a video node ' +
      'runs for minutes. Poll pleiades_flow_run for status, output and the debug trace. `inputs` is keyed by ' +
      'each input node\'s name (see `inputs` on pleiades_flow). Needs the "flows:write" scope.',
    method: 'POST',
    write: true,
    args: {
      id: { type: 'string', description: 'Flow _id', required: true },
      inputs: { type: 'object', description: 'Values for the flow\'s input nodes, keyed by input name' },
    },
    resolve: (a) => ({ path: `/api/flows/${a.id}/run`, body: { inputs: a.inputs ?? {} } }),
  },
  {
    name: 'stop_flow_run',
    description:
      'Stop an in-flight run. Also interrupts any queued ComfyUI job it was waiting on. Needs the "flows:write" scope.',
    method: 'POST',
    write: true,
    args: { run_id: { type: 'string', description: 'Run _id', required: true } },
    resolve: (a) => ({ path: `/api/flows/runs/${a.run_id}/stop` }),
  },
  {
    name: 'approve_flow_run',
    description:
      'Answer a run parked on an approval gate (status `awaiting_input`). Needs the "flows:write" scope.',
    method: 'POST',
    write: true,
    args: {
      run_id: { type: 'string', description: 'Run _id', required: true },
      approved: { type: 'boolean', description: 'true to approve, false to reject (default true)' },
    },
    resolve: (a) => ({
      path: `/api/flows/runs/${a.run_id}/approve`,
      body: { approved: a.approved !== false },
    }),
  },
];

/** Build the JSON Schema an MCP client needs to call a tool. */
export function inputSchemaOf(endpoint) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(endpoint.args)) {
    properties[name] = { type: spec.type, description: spec.description };
    // Free-form documents (agent/isolation/flow bodies) — the server validates the shape, not us.
    if (spec.type === 'object') properties[name].additionalProperties = true;
    // Likewise for lists (a flow's nodes/edges): accept any element rather than restating the schema
    // the backend already enforces and `flow_node_types` already publishes.
    if (spec.type === 'array') properties[name].items = {};
    if (spec.required) required.push(name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}
