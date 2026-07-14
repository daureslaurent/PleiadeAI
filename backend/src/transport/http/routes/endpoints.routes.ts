import { Router } from 'express';
import { endpointRepository } from '../../../domain/endpoints/endpoint.repository';
import { endpointService } from '../../../domain/endpoints/endpoint.service';
import { createLogger } from '../../../config/logger';

const log = createLogger('endpoints-routes');

/** CRUD for OpenAI-compatible inference endpoints + on-demand model autodiscovery. */
export const endpointsRouter = Router();

endpointsRouter.get('/', async (_req, res) => {
  res.json(await endpointRepository.list());
});

/** Live reachability probe of every endpoint (header badge). Never 5xx: down endpoints report `up: false`. */
endpointsRouter.get('/health', async (_req, res) => {
  res.json(await endpointService.probeHealth());
});

endpointsRouter.post('/', async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim() || typeof b.base_url !== 'string' || !b.base_url.trim()) {
    res.status(400).json({ error: 'name and base_url are required' });
    return;
  }
  const ep = await endpointRepository.create({
    name: b.name.trim(),
    base_url: b.base_url.trim(),
    api_key: typeof b.api_key === 'string' ? b.api_key : undefined,
    context_window: b.context_window !== undefined ? Number(b.context_window) : undefined,
    is_default: Boolean(b.is_default),
    fallback_order: b.fallback_order !== undefined ? Number(b.fallback_order) : undefined,
    supports_vision: b.supports_vision !== undefined ? Boolean(b.supports_vision) : undefined,
  });
  res.status(201).json(ep);
});

endpointsRouter.patch('/:id', async (req, res) => {
  const b = req.body ?? {};
  const existing = await endpointRepository.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const patch: Record<string, unknown> = {};
  // The system-managed local fallback has a forced identity: its name + URL are owned by the app
  // (re-asserted at boot), so ignore attempts to change them; everything else stays tunable.
  if (typeof b.name === 'string' && !existing.managed) patch.name = b.name.trim();
  if (typeof b.base_url === 'string' && !existing.managed) patch.base_url = b.base_url.trim();
  if (typeof b.api_key === 'string') patch.api_key = b.api_key;
  if (typeof b.default_model === 'string') patch.default_model = b.default_model;
  if (b.context_window !== undefined) patch.context_window = Number(b.context_window);
  if (b.context_window_mode === 'inherit' || b.context_window_mode === 'auto' || b.context_window_mode === 'manual') {
    patch.context_window_mode = b.context_window_mode;
  }
  if (b.fallback_order !== undefined) patch.fallback_order = Number(b.fallback_order);
  if (b.supports_vision !== undefined) patch.supports_vision = Boolean(b.supports_vision);
  const ep = await endpointRepository.update(req.params.id, patch);
  if (!ep) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(ep);
});

/** Refresh the cached model list from the server's `GET /v1/models`. */
endpointsRouter.post('/:id/discover', async (req, res) => {
  try {
    const ep = await endpointService.discoverModels(req.params.id);
    res.json(ep);
  } catch (err) {
    log.warn({ id: req.params.id, err: String(err) }, 'model discovery failed');
    res.status(502).json({ error: 'discovery failed', detail: err instanceof Error ? err.message : String(err) });
  }
});

/** Promote this endpoint to the fleet default (demotes all others). */
endpointsRouter.post('/:id/default', async (req, res) => {
  const ep = await endpointRepository.setDefault(req.params.id);
  if (!ep) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(ep);
});

endpointsRouter.delete('/:id', async (req, res) => {
  const ep = await endpointRepository.findById(req.params.id);
  if (!ep) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // The built-in local fallback is system-managed and would just be recreated at the next boot.
  if (ep.managed) {
    res.status(400).json({ error: 'the built-in local fallback endpoint cannot be deleted' });
    return;
  }
  await endpointRepository.delete(req.params.id);
  // If we removed the default, promote another so agents always have a target.
  if (ep.is_default) {
    const next = (await endpointRepository.list())[0];
    if (next) await endpointRepository.setDefault(next._id);
  }
  res.status(204).end();
});
