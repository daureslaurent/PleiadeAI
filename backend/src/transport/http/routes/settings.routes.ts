import { Router } from 'express';
import { settingsService, type EffectiveSettings } from '../../../domain/settings/settings.service';

/** Runtime inference settings (llama.cpp options) for the Settings page. */
export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  res.json(await settingsService.get());
});

settingsRouter.put('/', async (req, res) => {
  const b = req.body ?? {};
  // Whitelist + coerce numeric fields so the client can't inject arbitrary keys.
  const patch: Partial<EffectiveSettings> = {};
  if (typeof b.llama_url === 'string') patch.llama_url = b.llama_url;
  if (typeof b.llama_model === 'string') patch.llama_model = b.llama_model;
  if (typeof b.llama_api_key === 'string') patch.llama_api_key = b.llama_api_key;
  if (b.max_tokens !== undefined) patch.max_tokens = Number(b.max_tokens);
  if (b.context_window !== undefined) patch.context_window = Number(b.context_window);
  if (b.temperature !== undefined) patch.temperature = Number(b.temperature);
  if (b.top_p !== undefined) patch.top_p = Number(b.top_p);
  if (typeof b.title_endpoint_id === 'string') patch.title_endpoint_id = b.title_endpoint_id;
  if (typeof b.title_model === 'string') patch.title_model = b.title_model;
  // Guard against a value too low to fit a reasoning model's <think> block (would truncate titles).
  if (b.title_max_tokens !== undefined) patch.title_max_tokens = Math.max(32, Number(b.title_max_tokens) || 256);

  res.json(await settingsService.update(patch));
});
