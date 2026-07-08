#!/usr/bin/env node
/**
 * Mirror a prod PleiadeAI instance into the local one.
 *
 * Reads prod through the read-only API key (`GET /api/transfer/export/clone`) and writes locally
 * through the operator REST API (`POST /api/transfer/import/clone`). The import is **destructive**:
 * local agents, isolations, sessions, messages, scores and inference logs are dropped and replaced,
 * so `_id`s survive the trip and every cross-reference (session→agent, message→session,
 * score→run) still resolves. That is what makes it a mirror rather than a merge — use
 * Settings → Backup & Transfer if you want to merge one agent into an existing fleet.
 *
 *   node scripts/clone-prod.mjs                     # dry run: fetch, save, show what would change
 *   node scripts/clone-prod.mjs --apply             # actually replace local data (prompts first)
 *   node scripts/clone-prod.mjs --apply --yes       # no prompt (CI)
 *   node scripts/clone-prod.mjs --file=dump.json --apply   # re-import a saved dump, no refetch
 *   node scripts/clone-prod.mjs --logs=1000         # deeper inference-log history (default 200)
 *
 * Never copied: endpoints (they hold inference credentials), images, skills, settings, API keys,
 * Qdrant vectors. Agents relink to a same-named local endpoint, else the fleet default.
 *
 * Config (environment or the gitignored `.env.prod`):
 *   PLEIADE_API_URL / PLEIADE_API_KEY            — the prod source (read-only key)
 *   PLEIADE_LOCAL_URL                            — target, default http://localhost:8374
 *   PLEIADE_LOCAL_USERNAME / PLEIADE_LOCAL_PASSWORD — target operator login (AUTH_* in its .env)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { apiGet, envValue, loadConfig, PleiadeError } from '../tools/pleiade-mcp/client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DUMP_DIR = path.join(REPO_ROOT, '.dumps');

const COLLECTIONS = ['agents', 'isolations', 'sessions', 'messages', 'scores', 'llama_logs'];

function parseFlags(argv) {
  const flags = { apply: false, yes: false, force: false, logs: undefined, file: undefined, out: undefined };
  for (const token of argv) {
    const [key, value] = token.replace(/^--/, '').split('=');
    if (!token.startsWith('--') || !(key in flags)) throw new Error(`Unknown flag "${token}"`);
    if (typeof flags[key] === 'boolean') flags[key] = value === undefined || value === 'true';
    else flags[key] = value;
  }
  if (flags.logs !== undefined && !Number.isFinite(Number(flags.logs))) throw new Error('--logs must be a number');
  return flags;
}

function localTargetUrl() {
  return envValue('PLEIADE_LOCAL_URL', 'http://localhost:8374').replace(/\/+$/, '');
}

/**
 * The local target speaks operator JWT, not API keys — an API key could never write.
 *
 * Only ever called *after* {@link assertSafeTarget}: we must not transmit operator credentials to a
 * host we're about to reject as an unsafe target.
 */
async function localSession(baseUrl) {
  const username = envValue('PLEIADE_LOCAL_USERNAME');
  const password = envValue('PLEIADE_LOCAL_PASSWORD');
  if (!username || !password) {
    throw new Error(
      'Missing PLEIADE_LOCAL_USERNAME / PLEIADE_LOCAL_PASSWORD. These are the target instance\'s ' +
        'AUTH_USERNAME / AUTH_PASSWORD — put them in .env.prod, or export them for this run.',
    );
  }

  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).catch((err) => {
    throw new Error(`Cannot reach the local instance at ${baseUrl}: ${err.message}`);
  });
  if (!res.ok) throw new Error(`Local login rejected (${res.status}) — check PLEIADE_LOCAL_USERNAME/PASSWORD.`);

  const { token } = await res.json();
  return { baseUrl, token };
}

/** Refuse to "clone into" the machine we just read from, or into anything that isn't local. */
function assertSafeTarget(prodUrl, localUrl, force) {
  const normalize = (u) => u.replace(/\/+$/, '').toLowerCase();
  if (normalize(prodUrl) === normalize(localUrl)) {
    throw new Error(`Source and target are the same instance (${localUrl}). That would wipe prod. Aborting.`);
  }
  const host = new URL(localUrl).hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  if (!isLoopback && !force) {
    throw new Error(
      `PLEIADE_LOCAL_URL (${localUrl}) is not a loopback address. If you really mean to REPLACE the ` +
        `data on that host, re-run with --force.`,
    );
  }
}

async function fetchBundle(logs) {
  const query = logs === undefined ? {} : { logs };
  // A 404 here means prod predates the GET export routes — say so, rather than "unexpected token <".
  try {
    return await apiGet('/api/transfer/export/clone', query, { timeoutMs: 300_000 });
  } catch (err) {
    if (err instanceof PleiadeError && err.status === 404) {
      throw new Error(
        'Prod has no GET /api/transfer/export/clone — redeploy the backend there before cloning.',
      );
    }
    throw err;
  }
}

function saveBundle(bundle, out) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const file = out ?? path.join(DUMP_DIR, `pleiade-clone-${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(bundle));
  return file;
}

/** Read local counts so the dry run can show `local → prod` per collection instead of a bare total. */
async function localCounts({ baseUrl, token }) {
  const headers = { Authorization: `Bearer ${token}` };
  const get = async (p) => {
    const r = await fetch(`${baseUrl}${p}`, { headers });
    return r.ok ? r.json() : [];
  };
  const agents = await get('/api/agents');
  const sessionLists = await Promise.all(agents.map((a) => get(`/api/sessions?agentId=${a._id}`)));
  return {
    agents: agents.length,
    isolations: (await get('/api/isolations')).length,
    sessions: sessionLists.flat().length,
    messages: null, // not exposed in bulk; the import summary reports what was actually removed
    scores: (await get('/api/scoring/scores?limit=100000')).length,
    llama_logs: null,
  };
}

function printPlan(bundle, before) {
  console.log(`\nSnapshot taken ${bundle.exported_at}\n`);
  const width = Math.max(...COLLECTIONS.map((c) => c.length));
  console.log(`  ${'collection'.padEnd(width)}   local → prod`);
  for (const c of COLLECTIONS) {
    const from = before[c] === null || before[c] === undefined ? '?' : before[c];
    console.log(`  ${c.padEnd(width)}   ${String(from).padStart(5)} → ${String(bundle.counts[c] ?? 0).padStart(5)}`);
  }
}

async function confirm(localUrl) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nThis REPLACES all of the above on ${localUrl}. Local-only agents and sessions will be lost.\nType "REPLACE" to proceed: `,
  );
  rl.close();
  return answer.trim() === 'REPLACE';
}

async function applyBundle({ baseUrl, token }, bundle) {
  const res = await fetch(`${baseUrl}/api/transfer/import/clone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bundle, confirm: 'REPLACE' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Import failed (${res.status}): ${body.error ?? ''} ${body.detail ?? ''}`);
  return body;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  // Resolve both ends up front so a misconfiguration fails before we pull megabytes over the wire.
  // Order matters: vet the target *before* logging into it, so credentials never reach a host we'd
  // refuse to write to anyway.
  const { baseUrl: prodUrl } = loadConfig();
  const localUrl = localTargetUrl();
  assertSafeTarget(prodUrl, localUrl, flags.force);
  const local = await localSession(localUrl);

  let bundle;
  if (flags.file) {
    bundle = JSON.parse(fs.readFileSync(flags.file, 'utf8'));
    console.log(`Loaded ${flags.file}`);
  } else {
    console.log(`Reading ${prodUrl} (read-only API key)…`);
    bundle = await fetchBundle(flags.logs);
    const saved = saveBundle(bundle, flags.out);
    console.log(`Saved snapshot → ${path.relative(REPO_ROOT, saved)}`);
  }

  if (bundle.type !== 'pleiade-clone') throw new Error(`Not a pleiade-clone bundle (got "${bundle.type}").`);

  printPlan(bundle, await localCounts(local));

  if (!flags.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to replace local data.');
    return;
  }
  if (!flags.yes && !(await confirm(local.baseUrl))) {
    console.log('Aborted.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nReplacing data on ${local.baseUrl}…`);
  const summary = await applyBundle(local, bundle);
  console.log('\nwiped:    ', JSON.stringify(summary.wiped));
  console.log('inserted: ', JSON.stringify(summary.inserted));
  for (const w of summary.warnings ?? []) console.log(`  warning: ${w}`);
  console.log('\nDone. Reload the app; agents, sessions and scores now mirror prod.');
}

main().catch((err) => {
  console.error(`\n${err instanceof PleiadeError ? err.message : err.message ?? err}`);
  process.exitCode = 1;
});
