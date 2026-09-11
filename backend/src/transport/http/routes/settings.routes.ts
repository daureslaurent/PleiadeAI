import { Router } from 'express';
import {
  settingsService,
  SCREEN_CONTROL_MODES,
  UI_THEMES,
  UI_CHAT_LAYOUTS,
  type EffectiveSettings,
  type ScreenControlMode,
  type UiTheme,
  type UiChatLayout,
} from '../../../domain/settings/settings.service';
import { inferenceRuntime } from '../../../inference/runtime-config';
import { endpointHealth } from '../../../inference/endpoint-health';
import { scheduleUpdateCheck, stopUpdateCheck } from '../../../host';
import { applyTelegramConfig } from '../../../telegram/telegram-config';
import { telegramBot } from '../../../telegram/TelegramBot';
import { syncForumTick } from '../../../autonomy/agenda.setup';
import { Types } from 'mongoose';
import type { GlobalMode } from '../../../domain/endpoints/endpoint.model';
import { BUILTIN_GLOBAL_MODES, isBuiltinModeId } from '../../../domain/settings/builtin-modes';
import { moduleById } from '../../../modules/registry';
import { isCustomModuleId, type CustomModule } from '../../../modules/types';
import { createLogger } from '../../../config/logger';

const log = createLogger('settings-routes');

/** Runtime inference settings (llama.cpp options) for the Settings page. */
export const settingsRouter = Router();

/**
 * Normalize the operator's global modes (`MODES_PLAN.md`). Same contract as the endpoint-level
 * normalizer: the client PUTs the whole array, ids are minted here and *preserved* when present so
 * the conversations that selected a mode keep it, and a cleared name falls back rather than deleting
 * the entry. No `type` or `model` to coerce — a global mode is a prompt, on every model.
 */
function normalizeGlobalModes(raw: unknown): GlobalMode[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): GlobalMode[] => {
    const m = (entry ?? {}) as Record<string, unknown>;
    // The built-ins are code-defined and composed in on read; storing one would fork it from the
    // source and let it go stale. Dropping them here is also the guard against a client inventing a
    // `builtin:` id to smuggle a fake built-in into the document.
    if (typeof m.id === 'string' && isBuiltinModeId(m.id)) return [];
    return [{
      id: typeof m.id === 'string' && m.id ? m.id : new Types.ObjectId().toString(),
      name: (typeof m.name === 'string' ? m.name.trim() : '') || 'Untitled mode',
      type: 'prompt',
      enabled: m.enabled !== false,
      default_on: m.default_on === true,
      params: {},
      text: typeof m.text === 'string' ? m.text : '',
      placement: m.placement === 'user_suffix' ? 'user_suffix' : 'system_suffix',
    }];
  });
}

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
  // Operator appearance (`THEME_SYSTEM_PLAN.md`). Same rule as the screen-control mode: an id this
  // build doesn't know is ignored rather than stored, so an older client can't leave the UI with a
  // `data-theme` that nothing styles. Whitelisted here or the field silently never persists.
  if (UI_THEMES.includes(b.ui_theme as UiTheme)) patch.ui_theme = b.ui_theme as UiTheme;
  if (UI_CHAT_LAYOUTS.includes(b.ui_chat_layout as UiChatLayout))
    patch.ui_chat_layout = b.ui_chat_layout as UiChatLayout;
  // Who reads a screen for the GUI-control tools (auto / modal / legacy). An unknown value is
  // ignored rather than stored, so a typo can't leave the fleet in an undefined mode.
  if (SCREEN_CONTROL_MODES.includes(b.screen_control_mode as ScreenControlMode))
    patch.screen_control_mode = b.screen_control_mode as ScreenControlMode;
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
  // Concurrent execution of one batch of tool calls. `tool_parallel_max` is a count, and 0 is the
  // meaningful value "unlimited" rather than a mistyped 4 — so it is floored at 0, not at 1.
  if (b.tool_parallel_enabled !== undefined) patch.tool_parallel_enabled = Boolean(b.tool_parallel_enabled);
  if (b.tool_parallel_max !== undefined)
    patch.tool_parallel_max = Math.max(0, Math.trunc(Number(b.tool_parallel_max) || 0));
  // Per-turn tool-round ceiling; at least 1 round.
  if (b.max_tool_iterations !== undefined)
    patch.max_tool_iterations = Math.max(1, Number(b.max_tool_iterations) || 50);
  // Delegation-depth ceiling. Floor of 1 (0 would forbid delegation entirely, which is what the
  // per-agent tool list is for); capped at 10 so a mistyped value can't turn into runaway recursion.
  if (b.max_agent_hops !== undefined)
    patch.max_agent_hops = Math.min(10, Math.max(1, Number(b.max_agent_hops) || 5));
  // Fleet-wide AGENTS.md house rules. Operator-only — agents read this block, no tool writes it.
  if (typeof b.agents_md === 'string') patch.agents_md = b.agents_md;
  // Fleet-wide prompt modes, offered in every conversation. Whitelisted here or they silently
  // never persist, like every other settings key.
  if (b.global_modes !== undefined) patch.global_modes = normalizeGlobalModes(b.global_modes);
  // Which built-ins are switched off. Narrowed to ids that actually name one, so a stale id can't
  // accumulate in the document forever.
  if (Array.isArray(b.global_modes_disabled)) {
    const known = new Set(BUILTIN_GLOBAL_MODES.map((m) => m.id));
    patch.global_modes_disabled = (b.global_modes_disabled as unknown[]).filter(
      (id): id is string => typeof id === 'string' && known.has(id),
    );
  }
  // Which built-ins are standing (on everywhere without being picked). Same shape and the same
  // narrowing: the flag can't live on a mode that has no database row.
  if (Array.isArray(b.global_modes_default_on)) {
    const known = new Set(BUILTIN_GLOBAL_MODES.map((m) => m.id));
    patch.global_modes_default_on = (b.global_modes_default_on as unknown[]).filter(
      (id): id is string => typeof id === 'string' && known.has(id),
    );
  }
  // The module system (`MODULES_PLAN.md` §5). Whitelisted here or the fields silently never persist
  // — the one rule about this file. Narrowed on the way in the same way the mode lists are: only ids
  // this build knows, never a `mandatory` one, and only `custom:`-prefixed entries in the custom
  // list, so a request cannot smuggle a fake built-in into the document. The Modules page normally
  // writes through `/api/modules`, which validates the same way; this is the bulk path.
  if (Array.isArray(b.modules_disabled)) {
    patch.modules_disabled = (b.modules_disabled as unknown[]).filter((id): id is string => {
      if (typeof id !== 'string') return false;
      const mod = moduleById(id);
      return !!mod && mod.mandatory !== true;
    });
  }
  if (b.module_overrides && typeof b.module_overrides === 'object' && !Array.isArray(b.module_overrides)) {
    const clean: Record<string, Record<string, string>> = {};
    for (const [moduleId, blocks] of Object.entries(b.module_overrides as Record<string, unknown>)) {
      const mod = moduleById(moduleId);
      if (!mod || !blocks || typeof blocks !== 'object') continue;
      const mine: Record<string, string> = {};
      for (const [title, text] of Object.entries(blocks as Record<string, unknown>)) {
        const block = mod.blocks?.find((x) => x.title === title && x.overridable);
        if (block && typeof text === 'string' && text.trim()) mine[title] = text;
      }
      if (Object.keys(mine).length) clean[moduleId] = mine;
    }
    patch.module_overrides = clean;
  }
  if (Array.isArray(b.modules_custom)) {
    patch.modules_custom = (b.modules_custom as unknown[]).filter(
      (m): m is CustomModule =>
        !!m && typeof m === 'object' && isCustomModuleId(String((m as { id?: unknown }).id ?? '')),
    );
  }
  // Forum auto-reply: mentions run themselves, bounded by a per-thread budget. Floor of 1 — zero
  // would mean "enabled but nothing may ever run", which is just the switch being off.
  if (b.forum_auto_reply !== undefined) patch.forum_auto_reply = Boolean(b.forum_auto_reply);
  if (b.forum_auto_reply_max_per_thread !== undefined)
    patch.forum_auto_reply_max_per_thread = Math.max(1, Number(b.forum_auto_reply_max_per_thread) || 8);
  // The window the budget is measured over. 0 is meaningful — it restores the lifetime cap — so it
  // cannot go through the `|| default` idiom the other numbers use.
  if (b.forum_auto_reply_window_hours !== undefined) {
    const hours = Number(b.forum_auto_reply_window_hours);
    patch.forum_auto_reply_window_hours = Number.isFinite(hours) ? Math.max(0, Math.min(720, hours)) : 24;
  }
  // The work board (`FORUM_WORKBOARD_PLAN.md`). Whitelisted here or the field silently never
  // persists — the one rule about this file that has bitten every feature that touched it.
  if (b.forum_board_enabled !== undefined) patch.forum_board_enabled = Boolean(b.forum_board_enabled);
  if (b.forum_tick_interval_minutes !== undefined)
    patch.forum_tick_interval_minutes = Math.min(1440, Math.max(1, Number(b.forum_tick_interval_minutes) || 2));
  if (b.forum_max_parallel !== undefined)
    patch.forum_max_parallel = Math.min(8, Math.max(1, Number(b.forum_max_parallel) || 1));
  if (b.forum_task_max_dispatches !== undefined)
    patch.forum_task_max_dispatches = Math.min(10, Math.max(1, Number(b.forum_task_max_dispatches) || 3));
  if (b.forum_task_max_review_rounds !== undefined)
    patch.forum_task_max_review_rounds = Math.min(10, Math.max(1, Number(b.forum_task_max_review_rounds) || 2));
  if (b.forum_plan_max_turns !== undefined)
    patch.forum_plan_max_turns = Math.min(2000, Math.max(1, Number(b.forum_plan_max_turns) || 60));
  if (b.forum_plan_max_revisions !== undefined)
    patch.forum_plan_max_revisions = Math.min(50, Math.max(1, Number(b.forum_plan_max_revisions) || 6));
  if (typeof b.forum_project_manager_agent === 'string')
    patch.forum_project_manager_agent = b.forum_project_manager_agent.trim();
  // Subagent mode. Either half may be set alone: an endpoint with no model runs that endpoint's own
  // default, and a model with no endpoint runs on whatever endpoint the agent already uses.
  if (typeof b.forum_subagent_endpoint_id === 'string')
    patch.forum_subagent_endpoint_id = b.forum_subagent_endpoint_id.trim();
  if (typeof b.forum_subagent_model === 'string')
    patch.forum_subagent_model = b.forum_subagent_model.trim();
  if (b.forum_post_contract_enabled !== undefined)
    patch.forum_post_contract_enabled = Boolean(b.forum_post_contract_enabled);
  if (b.forum_auto_reply_max_per_project !== undefined)
    patch.forum_auto_reply_max_per_project = Math.max(
      1,
      Number(b.forum_auto_reply_max_per_project) || 40,
    );
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
  // Re-arm the board's clock only when its *cadence* changed. The enable switch is re-read inside
  // the tick, so toggling it needs no reschedule — rebuilding the job for that would just push the
  // next tick a full interval away every time the operator flipped it.
  if (patch.forum_tick_interval_minutes !== undefined) {
    void syncForumTick().catch((err) => log.error({ err }, 'forum tick reschedule failed'));
  }
  res.json(updated);
});
