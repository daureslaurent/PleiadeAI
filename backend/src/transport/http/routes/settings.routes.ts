import { Router } from 'express';
import { settingsService, type EffectiveSettings } from '../../../domain/settings/settings.service';
import { inferenceRuntime } from '../../../inference/runtime-config';
import { endpointHealth } from '../../../inference/endpoint-health';
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
  // Inference reliability / failover tunables. Floors keep a mistyped value from disabling failover
  // (a 0ms timeout) or hammering endpoints (a sub-second poll). Applied to `inferenceRuntime` below.
  if (b.inference_first_token_timeout_ms !== undefined)
    patch.inference_first_token_timeout_ms = Math.max(1000, Number(b.inference_first_token_timeout_ms) || 45000);
  if (b.inference_health_poll_interval_ms !== undefined)
    patch.inference_health_poll_interval_ms = Math.max(5000, Number(b.inference_health_poll_interval_ms) || 15000);
  if (b.inference_health_failure_threshold !== undefined)
    patch.inference_health_failure_threshold = Math.max(1, Number(b.inference_health_failure_threshold) || 2);
  if (b.inference_health_cooldown_ms !== undefined)
    patch.inference_health_cooldown_ms = Math.max(5000, Number(b.inference_health_cooldown_ms) || 60000);
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
  // ComfyUI server behind the media tools. Stored bare (no trailing slash) — the client appends
  // `/prompt`, `/view`, `/ws`… itself, and a doubled slash breaks ComfyUI's static routes.
  if (typeof b.comfy_url === 'string') patch.comfy_url = b.comfy_url.trim().replace(/\/+$/, '');
  if (b.comfy_queue_max !== undefined)
    patch.comfy_queue_max = Math.max(0, Number(b.comfy_queue_max) || 0);
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
  // Delegation-depth ceiling. Floor of 1 (0 would forbid delegation entirely, which is what the
  // per-agent tool list is for); capped at 10 so a mistyped value can't turn into runaway recursion.
  if (b.max_agent_hops !== undefined)
    patch.max_agent_hops = Math.min(10, Math.max(1, Number(b.max_agent_hops) || 5));
  // Fleet-wide AGENTS.md house rules. Operator-only — agents read this block, no tool writes it.
  if (typeof b.agents_md === 'string') patch.agents_md = b.agents_md;
  // Forum auto-reply: mentions run themselves, bounded by a per-thread budget. Floor of 1 — zero
  // would mean "enabled but nothing may ever run", which is just the switch being off.
  if (b.forum_auto_reply !== undefined) patch.forum_auto_reply = Boolean(b.forum_auto_reply);
  if (b.forum_auto_reply_max_per_thread !== undefined)
    patch.forum_auto_reply_max_per_thread = Math.max(1, Number(b.forum_auto_reply_max_per_thread) || 20);
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

  // Fleet monitoring (Monitor page). The poller re-reads these every tick, so a change takes effect
  // on the next poll with no restart. Floors here mirror the poller's own clamps; the thresholds are
  // free-form because "what counts as too hot" is the operator's call, not ours.
  if (b.monitor_poll_seconds !== undefined)
    patch.monitor_poll_seconds = Math.max(5, Number(b.monitor_poll_seconds) || 10);
  if (b.monitor_history_samples !== undefined)
    patch.monitor_history_samples = Math.min(100_000, Math.max(60, Number(b.monitor_history_samples) || 720));
  if (b.monitor_alerts_enabled !== undefined) patch.monitor_alerts_enabled = Boolean(b.monitor_alerts_enabled);
  if (b.monitor_alert_cooldown_minutes !== undefined)
    patch.monitor_alert_cooldown_minutes = Math.max(0, Number(b.monitor_alert_cooldown_minutes) || 0);
  for (const key of [
    'monitor_cpu_temp_warn',
    'monitor_cpu_temp_critical',
    'monitor_gpu_temp_warn',
    'monitor_gpu_temp_critical',
    'monitor_memory_warn',
    'monitor_memory_critical',
    'monitor_vram_warn',
    'monitor_vram_critical',
    'monitor_disk_warn',
    'monitor_disk_critical',
  ] as const) {
    if (b[key] === undefined) continue;
    const v = Number(b[key]);
    // 0 disables a rule (see `grade()` in monitor.alerts), so it is a legal value — but NaN isn't.
    if (Number.isFinite(v)) patch[key] = Math.max(0, v);
  }

  const updated = await settingsService.update(patch);
  // Push the inference reliability tunables into the in-memory runtime so routing/breaker pick them up
  // immediately; re-arm the health poller if its interval changed.
  if (inferenceRuntime.apply(updated)) endpointHealth.rearm();
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
