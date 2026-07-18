import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Singleton runtime settings (one document, `key: 'global'`). Holds llama.cpp inference options
 * that operators can tune from the Settings page without redeploying. Env values act as the
 * initial defaults (see settings.service).
 */
const SettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    llama_url: { type: String, required: true },
    llama_model: { type: String, required: true },
    llama_api_key: { type: String, default: 'sk-no-key-required' },
    max_tokens: { type: Number, default: 2048 },
    // Model context window (n_ctx); used to render session context usage as a fraction, and as the
    // fallback when auto-detection is off or a server doesn't report its n_ctx.
    context_window: { type: Number, default: 8192 },
    // Fleet default for the context-meter max: `true` = auto-detect each endpoint's real n_ctx from
    // the server (probed at model discovery into `endpoint.model_contexts`); `false` = use the manual
    // `context_window` numbers. Endpoints may override this per-endpoint (`context_window_mode`).
    context_window_auto: { type: Boolean, default: true },
    temperature: { type: Number, default: 0.7 },
    top_p: { type: Number, default: 0.95 },
    // Separate embeddings endpoint (CPU llama.cpp) backing Qdrant vector memory.
    embedding_url: { type: String, default: '' },
    embedding_model: { type: String, default: '' },
    embedding_api_key: { type: String, default: 'sk-no-key-required' },
    // Session title generation. Empty `title_endpoint_id` → reuse the responding agent's own
    // endpoint + model. Set it to route titles through a specific (usually cheaper) endpoint;
    // `title_model` picks the model there ('' → that endpoint's default). Failover applies either way.
    title_endpoint_id: { type: String, default: '' },
    title_model: { type: String, default: '' },
    // Vision analysis endpoint+model for the visual tools (approach A). `visual_screenshot` sends the
    // captured screenshot here and returns the model's textual analysis to a (text-only) agent. Empty
    // `vision_endpoint_id` → vision analysis is unavailable. `vision_model` '' → that endpoint's default.
    vision_endpoint_id: { type: String, default: '' },
    vision_model: { type: String, default: '' },
    /**
     * Sampling params for the vision analysis call. `null` = **disabled** → the value is NOT sent to
     * the server, so llama.cpp applies its own default. A number overrides it. Defaults preserve the
     * previous hard-coded behaviour (low temperature + light penalties to avoid repetition loops).
     */
    vision_temperature: { type: Number, default: 0.2 },
    vision_top_p: { type: Number, default: null },
    vision_max_tokens: { type: Number, default: 1024 },
    vision_frequency_penalty: { type: Number, default: 0.4 },
    vision_presence_penalty: { type: Number, default: 0.2 },
    // Image generation endpoint for the `generate_image` tool. Points at an OpenAI-compatible
    // `POST /v1/images/generations` server (e.g. the bundled image-gen/ stable-diffusion.cpp FLUX box).
    // Empty `image_endpoint_id` → `generate_image` reports it's unconfigured. `image_model` '' → that
    // endpoint's default model.
    image_endpoint_id: { type: String, default: '' },
    image_model: { type: String, default: '' },
    // Token budget for the title call. Must be generous enough that a reasoning model's `<think>`
    // block fits *and* leaves room for the title afterward — too low truncates mid-reasoning and
    // yields an empty/garbage title (see session-titler).
    title_max_tokens: { type: Number, default: 256 },
    // Host self-update master switch (off by default). Gates the "Update app" action and the
    // periodic update check. See backend/src/host + tools/updater.
    update_enabled: { type: Boolean, default: false },
    // How often the backend triggers a read-only host update check (git fetch + compare).
    update_check_interval_hours: { type: Number, default: 1 },
    // Conversation Quality Scorer (LLM-as-judge). Off by default; when on, each completed turn is
    // scored 0–100 + tagged. Empty `scoring_endpoint_id` → reuse the responding agent's own endpoint.
    scoring_enabled: { type: Boolean, default: false },
    scoring_endpoint_id: { type: String, default: '' },
    scoring_model: { type: String, default: '' },
    scoring_max_tokens: { type: Number, default: 1024 },
    // Fleet default for the per-turn tool-round ceiling. An agent may override it with its own
    // `max_tool_iterations`; when the agent leaves that blank this value applies. Guards tool loops.
    max_tool_iterations: { type: Number, default: 50 },
    /**
     * Fleet-wide AGENTS.md — house rules injected into *every* agent's system prompt (subagents
     * included) as a read-only block. Operator-owned: no tool writes it. Per-agent standing
     * instructions live in `agent.agents_md`; the agent's own writable doc is `agent.notebook`.
     */
    agents_md: { type: String, default: '' },
    /**
     * Memory distillation (`docs/memory-souvenirs.md`). When on, a completed turn is passed back
     * through the agent's *own* model, which writes 0..N standalone memories instead of the raw
     * transcript being dumped into Qdrant verbatim. Costs one short extra completion per turn, so
     * it is a switch; off means the agent only remembers what it deliberately saves via `remember`.
     */
    memory_distill_enabled: { type: Boolean, default: true },
    /** Token budget for that distillation call. The reply is a small JSON object. */
    memory_max_tokens: { type: Number, default: 800 },
    /**
     * Google OAuth client for linking Gmail mailboxes (Settings → Connections; `GMAIL_TOOL_PLAN.md`).
     * The operator creates the OAuth client once in the Google Cloud console and registers
     * `<public_base_url>/api/mail/oauth/callback` as its redirect URI — the UI shows that exact
     * string. `google_client_secret` is scrubbed from API-key responses by `redact.ts` (`secret$`).
     */
    public_base_url: { type: String, default: '' },
    google_client_id: { type: String, default: '' },
    google_client_secret: { type: String, default: '' },
    /**
     * Telegram bot for outbound alerts + the interactive operator bot (Autonomy page). '' → fall
     * back to the TELEGRAM_* env vars. `telegram_chat_ids` is a comma list of chat ids that both
     * receive alerts and are allowed to talk to the bot. Token is scrubbed from API-key responses
     * by `redact.ts` (`token$`).
     */
    telegram_bot_token: { type: String, default: '' },
    telegram_chat_ids: { type: String, default: '' },

    /**
     * Fleet monitoring (Monitor page, `domain/monitor/`). The poller reads every enabled
     * `monitor_targets` doc on `monitor_poll_seconds`; the thresholds below decide when a reading
     * turns amber (warn) or red (critical) on the dashboard and — when `monitor_alerts_enabled` —
     * fires into the inbox + Telegram.
     *
     * One set of thresholds for the whole fleet, not per target: the point is a single glanceable
     * "is anything hot/full" rule, and per-box tuning is a config surface nobody maintains. The
     * defaults are conservative for consumer hardware (an Intel package sits ~82°C `high`, NVIDIA
     * consumer cards throttle in the 83-93°C range).
     */
    monitor_poll_seconds: { type: Number, default: 10 },
    monitor_alerts_enabled: { type: Boolean, default: true },
    monitor_cpu_temp_warn: { type: Number, default: 80 },
    monitor_cpu_temp_critical: { type: Number, default: 90 },
    monitor_gpu_temp_warn: { type: Number, default: 80 },
    monitor_gpu_temp_critical: { type: Number, default: 88 },
    monitor_memory_warn: { type: Number, default: 85 },
    monitor_memory_critical: { type: Number, default: 95 },
    monitor_vram_warn: { type: Number, default: 90 },
    monitor_vram_critical: { type: Number, default: 97 },
    monitor_disk_warn: { type: Number, default: 85 },
    monitor_disk_critical: { type: Number, default: 95 },
    /** Minutes before the same breach on the same target may alert again (0 = every evaluation). */
    monitor_alert_cooldown_minutes: { type: Number, default: 30 },
  },
  { collection: 'settings', timestamps: { createdAt: false, updatedAt: 'updated_at' } },
);

export type Settings = InferSchemaType<typeof SettingsSchema>;
export type SettingsDoc = HydratedDocument<Settings>;

export const SettingsModel = model('Settings', SettingsSchema);
