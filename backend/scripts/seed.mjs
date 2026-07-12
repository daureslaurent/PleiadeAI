// Seed a fresh PleiadesAI database with demo agents and a skill so the UI has content.
// Usage: node scripts/seed.mjs  (targets API_URL, default http://localhost:4000)
const API = process.env.API_URL || 'http://localhost:4000';
const USER = process.env.AUTH_USERNAME || 'admin';
const PASS = process.env.AUTH_PASSWORD || 'change-me';

async function main() {
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { token } = await login.json();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const post = async (path, body) => {
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`POST ${path} → ${res.status} ${text.slice(0, 120)}`);
  };

  // A trivial TS skill so the sandbox + Matrix editor have something to run.
  await post('/api/skills', {
    name: 'echo_upper',
    description: 'Uppercases the provided text.',
    language: 'ts',
    source: 'export default async function run(args: { text: string }) {\n  return { upper: (args.text ?? "").toUpperCase() };\n}\n',
    parameters_schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    enabled: true,
  });

  await post('/api/agents', {
    name: 'devops_agent',
    description: 'Handles deployments, infrastructure, and CI/CD questions.',
    system_prompt: 'You are a DevOps agent. Be concise and precise.',
    tools_allowed: ['set_agent_parameter', 'update_notebook', 'web_search', 'webfetch', 'remember', 'ask_agent', 'annuaire', 'echo_upper'],
    qdrant_namespace: 'devops_agent',
    parameters: { ssh_target: 'user@10.0.0.5', region: 'eu-west-1' },
    agents_md:
      '# Notes\n\n- Deployments target the `eu-west-1` region.\n- Prefer `docker compose` over the legacy `docker-compose` binary.\n',
  });

  await post('/api/agents', {
    name: 'home_coordinator',
    description: 'Coordinates home automation queries and routes them to the right room/device.',
    system_prompt: 'You coordinate home automation queries.',
    tools_allowed: ['set_agent_parameter'],
    qdrant_namespace: 'home_coordinator',
    parameters: { default_room: 'living_room' },
  });

  console.log('seed complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
