#!/usr/bin/env node
/**
 * Deploy the `Phone` agent — an Android device operator — and its device registration to a running
 * instance. Idempotent: re-running patches the existing docs instead of duplicating them, so this is
 * also how you push a prompt edit.
 *
 *   node scripts/deploy-android-agent.mjs [--dry-run] [--agent-only] [--isolation=<name|id>]
 *
 * Definitions live in `scripts/agents/` (`phone.json`, `phone-device.json`). A `"field": "@file.md"`
 * value is replaced by that file's contents, so the long prompts stay editable as Markdown.
 *
 * Unlike the research pair this script does **not** create an image or an isolation profile: the
 * Android image has to be built on the box (it downloads adb + scrcpy-server), which is a UI/CLI
 * build job, not a config write. It therefore *finds* a profile whose image carries the Android
 * layer and refuses clearly if there isn't one.
 *
 * Needs an API key with `agents:write` **and** `android:write` (Settings → API Keys), in
 * PLEIADES_API_KEY / `.env.prod`. See ANDROID_PLAN.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, apiSend, PleiadesError } from '../tools/pleiades-mcp/client.mjs';

const DEFS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agents');
const DRY_RUN = process.argv.includes('--dry-run');
const AGENT_ONLY = process.argv.includes('--agent-only');
const ISOLATION = process.argv.find((a) => a.startsWith('--isolation='))?.split('=').slice(1).join('=');

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

/**
 * Pick the isolation profile the agent will run in. `adb` lives in the agent's container, so the
 * profile's image must carry the Android layer — an agent on any other profile gets the tools and
 * then fails on every call, which reads like a broken tool rather than a misconfiguration.
 */
async function resolveIsolation() {
  const [isolations, images] = await Promise.all([apiGet('/api/isolations'), apiGet('/api/images')]);
  const androidImageIds = new Set(images.filter((i) => i.android).map((i) => String(i._id)));

  const candidates = isolations.filter((iso) => iso.image_id && androidImageIds.has(String(iso.image_id)));
  if (!candidates.length) {
    throw new Error(
      'No isolation profile uses an Android image.\n' +
        'On the Images page, enable "Android control" on an image and build it, then create a profile\n' +
        'that references it (host network is simplest — see the note about adb_host below).',
    );
  }

  const chosen = ISOLATION
    ? candidates.find((c) => c.name === ISOLATION || String(c._id) === ISOLATION)
    : candidates[0];
  if (!chosen) {
    throw new Error(
      `No Android-capable isolation profile matches "${ISOLATION}". Candidates: ${candidates
        .map((c) => c.name)
        .join(', ')}`,
    );
  }
  if (!ISOLATION && candidates.length > 1) {
    console.log(
      `  ! ${candidates.length} Android-capable profiles exist — using "${chosen.name}". ` +
        'Pass --isolation=<name> to pick another.',
    );
  }

  const image = images.find((i) => String(i._id) === String(chosen.image_id));
  if (image.image_status !== 'built') {
    throw new Error(`image "${image.name}" is ${image.image_status}, not built — build it first`);
  }
  console.log(`  profile "${chosen.name}" on image "${image.name}" (built ✓, network: ${chosen.network})`);
  return chosen;
}

/**
 * The one configuration mistake that actually happens: `adb_host` is resolved from inside the
 * *agent's container*, so a loopback address only reaches an emulator on the host when the profile
 * shares the host's network namespace. Catch it here rather than at the agent's first tool call.
 */
function checkReachability(device, isolation) {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(device.adb_host);
  if (loopback && isolation.network !== 'host') {
    console.log(
      `  ! adb_host is ${device.adb_host} but profile "${isolation.name}" is on the ` +
        `"${isolation.network}" network, so that address is the *container*, not the host.\n` +
        '    Use the bridge gateway (172.17.0.1) or the host\'s LAN address instead.',
    );
  }
  if (isolation.network === 'ssh') {
    console.log(
      '  ! "ssh" profiles execute on a remote host, so the live mirror is refused there ' +
        '(the agent would drive one device while you watched another).',
    );
  }
}

async function main() {
  console.log(`Deploying the Phone agent${DRY_RUN ? ' (dry run)' : ''}…\n`);

  console.log('Isolation:');
  const isolation = await resolveIsolation();
  console.log('');

  let deviceId;
  if (AGENT_ONLY) {
    console.log('Device: skipped (--agent-only) — link it on the Agents page.\n');
  } else {
    console.log('Android device:');
    const device = loadDef('phone-device.json');
    checkReachability(device, isolation);
    const devices = await apiGet('/api/android-devices');
    deviceId = await upsert('android-devices', device, devices);

    // Probe it while we're here: an unreachable emulator is much cheaper to learn about now than
    // from the agent's first turn. Advisory only — it runs from the backend, not the container.
    if (!DRY_RUN) {
      try {
        const probe = await apiSend('POST', `/api/android-devices/${deviceId}/test`);
        console.log(`  ${probe.ok ? '✓' : '!'} ${probe.message}`);
      } catch (err) {
        console.log(`  ! could not test the device: ${err.message}`);
      }
    }
    console.log('');
  }

  console.log('Agent:');
  const agents = await apiGet('/api/agents');
  const doc = loadDef('phone.json');
  doc.isolation_id = isolation._id;
  // Leave the link alone in agent-only mode, so re-running never clears a hand-made assignment.
  if (deviceId) doc.android_device_id = deviceId;
  const agentId = await upsert('agents', doc, agents);

  console.log(
    `\nDone. "Phone" runs in "${isolation.name}" and drives the registered device; the android_* tools\n` +
      'are granted automatically by the device link, so they are deliberately absent from tools_allowed.',
  );
  if (!DRY_RUN) {
    console.log(
      `Open it in the Workspace and use the Phone button for the live screen (agent ${agentId}).\n` +
        'The container builds lazily on first tool use — the first turn will be slow.',
    );
  }
}

main().catch((err) => {
  if (err instanceof PleiadesError && err.status === 403) {
    console.error(
      `${err.message}\n\n` +
        'This script needs an API key with both "agents:write" and "android:write".\n' +
        '"android:write" only exists on a backend built after the Android feature — if prod predates\n' +
        'it, register the device by hand (Settings → Connections) and re-run with --agent-only:\n' +
        'the agent is then created and you link the device on the Agents page.',
    );
  } else {
    console.error(err.message ?? err);
  }
  process.exitCode = 1;
});
