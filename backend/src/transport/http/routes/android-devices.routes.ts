import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { androidDeviceRepository } from '../../../domain/android-devices/android-device.repository';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { probeAdb } from '../../../domain/android-devices/adb-probe';

const log = createLogger('android-devices-routes');

/** CRUD for the registered Android devices (Settings → Connections) + an adb reachability probe. */
export const androidDevicesRouter = Router();

/** Fields an operator may set. Anything else in the body (status fields, ids) is ignored. */
const EDITABLE = [
  'name',
  'description',
  'adb_host',
  'adb_port',
  'mirror_max_size',
  'mirror_bit_rate',
  'mirror_max_fps',
  'mirror_audio',
  'mirror_audio_codec',
  'enabled',
] as const;

type Editable = Partial<Record<(typeof EDITABLE)[number], unknown>>;

function pickEditable(body: Record<string, unknown>): Editable {
  const patch: Editable = {};
  for (const key of EDITABLE) if (key in body) patch[key] = body[key];
  if (typeof patch.adb_port === 'string') patch.adb_port = Number(patch.adb_port);
  if ('mirror_audio' in patch) patch.mirror_audio = Boolean(patch.mirror_audio);
  // An unknown codec would be rejected by the schema enum with an opaque error; drop it instead so
  // the device keeps whatever it had.
  if ('mirror_audio_codec' in patch && !['aac', 'opus', 'flac'].includes(String(patch.mirror_audio_codec))) {
    delete patch.mirror_audio_codec;
  }
  for (const numeric of ['adb_port', 'mirror_max_size', 'mirror_bit_rate', 'mirror_max_fps'] as const) {
    if (numeric in patch) patch[numeric] = Number(patch[numeric]) || undefined;
  }
  return patch;
}

androidDevicesRouter.get('/', async (_req, res) => {
  res.json(await androidDeviceRepository.list());
});

androidDevicesRouter.post('/', async (req, res) => {
  const patch = pickEditable(req.body ?? {});
  const name = String(patch.name ?? '').trim();
  const host = String(patch.adb_host ?? '').trim();
  if (!name || !host) {
    res.status(400).json({ error: 'name and adb_host are required' });
    return;
  }
  try {
    const device = await androidDeviceRepository.create({
      ...patch,
      name,
      adb_host: host,
    } as Parameters<typeof androidDeviceRepository.create>[0]);
    log.info({ id: String(device._id), name }, 'android device created');
    res.status(201).json(device);
  } catch (err) {
    // The unique index on `name` is the only realistic failure here.
    res.status(409).json({ error: 'could not create the device', detail: String(err) });
  }
});

androidDevicesRouter.patch('/:id', async (req, res) => {
  const patch = pickEditable(req.body ?? {}) as Parameters<typeof androidDeviceRepository.update>[1];
  const device = await androidDeviceRepository.update(req.params.id, patch);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(device);
});

/**
 * Delete a device, unlinking it from every agent that referenced it first — an agent left pointing
 * at a deleted id would keep its Android tools granted and fail on every call with a confusing
 * "device not found" instead of simply losing the capability.
 */
androidDevicesRouter.delete('/:id', async (req, res) => {
  const device = await androidDeviceRepository.delete(req.params.id);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const unlinked = await agentRepository.clearAndroidDevice(req.params.id);
  log.info({ id: req.params.id, unlinked }, 'android device deleted');
  res.json({ ok: true, unlinked_agents: unlinked });
});

/**
 * Probe the device's adb port and record the verdict on the doc. Advisory only: it runs from the
 * *backend* container, whereas the tools run from the agent's — see `adb-probe.ts`.
 */
androidDevicesRouter.post('/:id/test', async (req, res) => {
  const device = await androidDeviceRepository.findById(req.params.id);
  if (!device) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const result = await probeAdb(device.adb_host, device.adb_port || 5555);
  await androidDeviceRepository.update(device._id, {
    last_status: result.ok ? 'ok' : 'error',
    last_error: result.ok ? '' : result.message,
    last_checked_at: new Date(),
    ...(result.model ? { last_seen_model: result.model } : {}),
  });
  res.json(result);
});
