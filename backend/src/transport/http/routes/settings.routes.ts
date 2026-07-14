import { Router } from 'express';
import { settingsService, type EffectiveSettings } from '../../../domain/settings/settings.service';
import { scheduleUpdateCheck, stopUpdateCheck } from '../../../host';
import { applyTelegramConfig } from '../../../telegram/telegram-config';
import { telegramBot } from '../../../telegram/TelegramBot';
import { createLogger } from '../../../config/logger';

const log = createLogger('settings-routes');

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
  if (b.context_window_auto !== undefined) patch.context_window_auto = Boolean(b.context_window_auto);
  if (b.temperature !== undefined) patch.temperature = Number(b.temperature);
  if (b.top_p !== undefined) patch.top_p = Number(b.top_p);
  if (typeof b.title_endpoint_id === 'string') patch.title_endpoint_id = b.title_endpoint_id;
  if (typeof b.title_model === 'string') patch.title_model = b.title_model;
  if (typeof b.vision_endpoint_id === 'string') patch.vision_endpoint_id = b.vision_endpoint_id;
  if (typeof b.vision_model === 'string') patch.vision_model = b.vision_model;
  // Vision sampling params: `null`/'' → disabled (stored null, not sent to the model); a finite
  // number overrides. Anything else for a present key is ignored.
  for (const key of [
    'vision_temperature',
    'vision_top_p',
    'vision_max_tokens',
    'vision_frequency_penalty',
    'vision_presence_penalty',
  ] as const) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v === null || v === '') patch[key] = null;
    else if (Number.isFinite(Number(v))) patch[key] = Number(v);
  }
  // Image generation endpoint for `generate_image`.
  if (typeof b.image_endpoint_id === 'string') patch.image_endpoint_id = b.image_endpoint_id;
  if (typeof b.image_model === 'string') patch.image_model = b.image_model;
  // Guard against a value too low to fit a reasoning model's <think> block (would truncate titles).
  if (b.title_max_tokens !== undefined) patch.title_max_tokens = Math.max(32, Number(b.title_max_tokens) || 256);
  if (b.update_enabled !== undefined) patch.update_enabled = Boolean(b.update_enabled);
  // At least hourly; a shorter loop just spams `git fetch` on the host with no benefit.
  if (b.update_check_interval_hours !== undefined)
    patch.update_check_interval_hours = Math.max(1, Number(b.update_check_interval_hours) || 1);
  // Conversation Quality Scorer.
  if (b.scoring_enabled !== undefined) patch.scoring_enabled = Boolean(b.scoring_enabled);
  if (typeof b.scoring_endpoint_id === 'string') patch.scoring_endpoint_id = b.scoring_endpoint_id;
  if (typeof b.scoring_model === 'string') patch.scoring_model = b.scoring_model;
  if (b.scoring_max_tokens !== undefined)
    patch.scoring_max_tokens = Math.max(64, Number(b.scoring_max_tokens) || 1024);
  // Per-turn tool-round ceiling; at least 1 round.
  if (b.max_tool_iterations !== undefined)
    patch.max_tool_iterations = Math.max(1, Number(b.max_tool_iterations) || 50);
  // Fleet-wide AGENTS.md house rules. Operator-only — agents read this block, no tool writes it.
  if (typeof b.agents_md === 'string') patch.agents_md = b.agents_md;
  // Post-turn memory distillation (docs/memory-souvenirs.md).
  if (b.memory_distill_enabled !== undefined)
    patch.memory_distill_enabled = Boolean(b.memory_distill_enabled);
  if (b.memory_max_tokens !== undefined)
    patch.memory_max_tokens = Math.max(128, Number(b.memory_max_tokens) || 800);
  // Gmail linking (Settings → Connections): OAuth client + the public base the redirect URI hangs off.
  if (typeof b.public_base_url === 'string') patch.public_base_url = b.public_base_url.trim().replace(/\/+$/, '');
  if (typeof b.google_client_id === 'string') patch.google_client_id = b.google_client_id.trim();
  if (typeof b.google_client_secret === 'string') patch.google_client_secret = b.google_client_secret.trim();
  // Telegram bot (Autonomy page): token + comma list of chat ids. '' → fall back to env.
  if (typeof b.telegram_bot_token === 'string') patch.telegram_bot_token = b.telegram_bot_token.trim();
  if (typeof b.telegram_chat_ids === 'string') patch.telegram_chat_ids = b.telegram_chat_ids.trim();

  const updated = await settingsService.update(patch);
  // (Re)arm or stop the periodic host update check to match the new settings.
  if (updated.update_enabled) scheduleUpdateCheck(updated.update_check_interval_hours);
  else stopUpdateCheck();
  // Push the (possibly unchanged) telegram config into the runtime and bounce the interactive bot
  // so a new token/allowlist takes effect without a redeploy. Fire-and-forget: the restart waits
  // for the in-flight long-poll (≤ ~40s) to unwind.
  if (patch.telegram_bot_token !== undefined || patch.telegram_chat_ids !== undefined) {
    applyTelegramConfig(updated);
    void telegramBot.restart().catch((err) => log.error({ err }, 'telegram bot restart failed'));
  }
  res.json(updated);
});
