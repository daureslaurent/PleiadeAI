#!/usr/bin/env node
/**
 * Read-only CLI against a deployed PleiadesAI instance. Same surface as the MCP server
 * (`tools/pleiades-mcp/`), for shell use and as a fallback when MCP isn't wired up.
 *
 *   node scripts/prod.mjs                          # list subcommands
 *   node scripts/prod.mjs agents
 *   node scripts/prod.mjs sessions --agent_id=64f…
 *   node scripts/prod.mjs llama_logs --limit=25
 *   node scripts/prod.mjs get --path=/api/isolations
 *
 * Config: PLEIADES_API_URL + PLEIADES_API_KEY, from the environment or the repo's `.env.prod`.
 */
import { apiGet, PleiadesError } from '../tools/pleiades-mcp/client.mjs';
import { ENDPOINTS } from '../tools/pleiades-mcp/endpoints.mjs';

const byName = new Map(ENDPOINTS.map((e) => [e.name, e]));

/** Parse `--key=value` / `--flag` into an object, coercing to each argument's declared type. */
function parseArgs(argv, endpoint) {
  const out = {};
  for (const token of argv) {
    if (!token.startsWith('--')) throw new Error(`Unexpected argument "${token}" — expected --key=value`);
    const [rawKey, ...rest] = token.slice(2).split('=');
    const spec = endpoint.args[rawKey];
    if (!spec) throw new Error(`Unknown option --${rawKey} for "${endpoint.name}"`);

    const raw = rest.join('=');
    if (spec.type === 'boolean') out[rawKey] = raw === '' || raw === 'true';
    else if (spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`--${rawKey} must be a number, got "${raw}"`);
      out[rawKey] = n;
    } else out[rawKey] = raw;
  }

  for (const [name, spec] of Object.entries(endpoint.args)) {
    if (spec.required && out[name] === undefined) throw new Error(`Missing required --${name}`);
  }
  return out;
}

function usage() {
  console.log('Read-only access to a PleiadesAI instance.\n\nUsage: node scripts/prod.mjs <command> [--key=value ...]\n');
  const width = Math.max(...ENDPOINTS.map((e) => e.name.length));
  for (const e of ENDPOINTS) {
    console.log(`  ${e.name.padEnd(width)}  ${e.description}`);
    for (const [name, spec] of Object.entries(e.args)) {
      console.log(`  ${' '.repeat(width)}    --${name}${spec.required ? ' (required)' : ''}: ${spec.description}`);
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const endpoint = byName.get(command);
  if (!endpoint) {
    console.error(`Unknown command "${command}".\n`);
    usage();
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(rest, endpoint);
  const { path, query } = endpoint.resolve(args);
  const data = await apiGet(path, query);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err instanceof PleiadesError ? err.message : `${err.message ?? err}`);
  process.exitCode = 1;
});
