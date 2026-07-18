#!/usr/bin/env node
/**
 * Deploy the deep-research pair (`researcher` + `research_critic`) and their `research` isolation
 * profile to a running instance. Idempotent: re-running patches the existing docs instead of
 * duplicating them, so this is also how you push a prompt edit.
 *
 *   node scripts/deploy-research-agents.mjs [--dry-run] [--agents-only]
 *
 * `--agents-only` skips the isolation profile and leaves `isolation_id` untouched, for when the
 * profile is assigned by hand on the Isolations page. It needs only the `agents:write` scope, so it
 * works against a backend built before `isolations:write` existed.
 *
 * Definitions live in `scripts/agents/`. A `"field": "@file.md"` value is replaced by that file's
 * contents, so the long prompts stay editable as Markdown rather than escaped JSON.
 *
 * Needs an API key with **both** `agents:write` and `isolations:write` (Settings → API Keys), in
 * PLEIADES_API_KEY / `.env.prod`. See RESEARCHER_AGENT_PLAN.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, apiSend, PleiadesError } from '../tools/pleiades-mcp/client.mjs';

const DEFS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agents');
const DRY_RUN = process.argv.includes('--dry-run');
const AGENTS_ONLY = process.argv.includes('--agents-only');

/** Load a definition, expanding every `"@relative/file"` value against the definitions directory. */
function loadDef(file) {
  const doc = JSON.parse(fs.readFileSync(path.join(DEFS, file), 'utf8'));
  for (const [key, value] of Object.entries(doc)) {
    if (typeof value === 'string' && value.startsWith('@')) {
      doc[key] = fs.readFileSync(path.join(DEFS, value.slice(1)), 'utf8');
    }
  }
  return doc;
}

async function send(method, pathname, body) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${method} ${pathname}`);
    return { _id: '<dry-run>' };
  }
  return apiSend(method, pathname, { body });
}

/** Create `doc` under `collection`, or PATCH the existing row with the same name. */
async function upsert(collection, doc, existing) {
  const match = existing.find((row) => row.name === doc.name);
  if (match) {
    console.log(`  ~ ${doc.name} exists (${match._id}) — patching`);
    await send('PATCH', `/api/${collection}/${match._id}`, doc);
    return match._id;
  }
  console.log(`  + ${doc.name} — creating`);
  const created = await send('POST', `/api/${collection}`, doc);
  return created._id;
}

async function main() {
  console.log(`Deploying research agents${DRY_RUN ? ' (dry run)' : ''}…\n`);

  let isolationId;
  if (AGENTS_ONLY) {
    console.log('Isolation profile: skipped (--agents-only) — assign it on the Isolations page.\n');
  } else {
    console.log('Isolation profile:');
    const isolations = await apiGet('/api/isolations');
    const isolationDef = loadDef('research-isolation.json');

    // The profile is useless without a built image — an agent assigned to an imageless profile fails
    // with IsolationNotReadyError on its first tool call, which reads like a code bug.
    const images = await apiGet('/api/images');
    const image = images.find((i) => String(i._id) === isolationDef.image_id);
    if (!image) throw new Error(`image_id ${isolationDef.image_id} not found on this instance`);
    if (image.image_status !== 'built') {
      throw new Error(`image "${image.name}" is ${image.image_status}, not built — build it first`);
    }
    console.log(`  image "${image.name}" is built ✓`);

    isolationId = await upsert('isolations', isolationDef, isolations);
    console.log('');
  }

  console.log('Agents:');
  const agents = await apiGet('/api/agents');
  for (const file of ['researcher.json', 'research-critic.json']) {
    const doc = loadDef(file);
    // Leave `isolation_id` alone in agents-only mode, so re-running never clears a hand-made assignment.
    if (isolationId) doc.isolation_id = isolationId;
    await upsert('agents', doc, agents);
  }

  if (AGENTS_ONLY) {
    console.log(
      '\nDone. Both agents still need an isolation profile assigned (Agents page) before their\n' +
        'file/bash tools work — until then they only have web tools and memory.',
    );
  } else {
    console.log('\nDone. The pair shares the "research" profile; each has its own /workspace.');
  }
  if (!DRY_RUN) console.log('Containers build lazily on first tool use — the first turn will be slow.');
}

main().catch((err) => {
  if (err instanceof PleiadesError && err.status === 403) {
    console.error(
      `${err.message}\n\n` +
        `The key needs agents:write and isolations:write. isolations:write only exists on a backend\n` +
        `built after this change — until prod is rebuilt, create the "research" profile by hand on the\n` +
        `Isolations page (bridge network, CodeSpace image) and re-run: this script matches it by name.`,
    );
  } else {
    console.error(err.message ?? err);
  }
  process.exitCode = 1;
});
