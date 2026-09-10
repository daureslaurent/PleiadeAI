import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * One global mode. Mirrors the endpoint-level `ModeSchema` minus `model` (it applies to all of them)
 * and minus `type` (always `prompt`). `minimize: false` for the same reason as there: an empty
 * object must survive the write.
 */
const GlobalModeSchema = new Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    /** Standing: on in every conversation and every side task until one explicitly opts out. */
    default_on: { type: Boolean, default: false },
    text: { type: String, default: '' },
    placement: { type: String, enum: ['system_suffix', 'user_suffix'], default: 'system_suffix' },
  },
  { _id: false, minimize: false },
);

/**
 * Singleton runtime settings (one document, `key: 'global'`). Holds llama.cpp inference options
 * that operators can tune from the Settings page without redeploying. Env values act as the
 * initial defaults (see settings.service).
 */
const SettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    /**
     * Operator appearance (`THEME_SYSTEM_PLAN.md`): which theme the app wears and how the chat
     * page is structured. Nothing on the backend reads them — they live here rather than in the
     * browser so the choice follows the operator to another device. Validated on the way in and
     * on the way out (`settings.service`), never enum-constrained here, so a build that drops a
     * theme degrades to the default instead of failing every write to the document.
     */
    ui_theme: { type: String, default: 'pleiades' },
    ui_chat_layout: { type: String, default: 'hybrid' },
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
    /**
     * Inference reliability / failover tunables (Settings → Inference). All `null` → fall back to the
     * INFERENCE_* env defaults (see settings.service). Mirrored into `inferenceRuntime` so the hot
     * routing paths read them synchronously; a save takes effect without a restart.
     * - first-token timeout: per-attempt budget before failover moves to the next endpoint.
     * - health poll interval: how often the background breaker probes every endpoint.
     * - failure threshold: consecutive failures before an endpoint is parked as down.
     * - cooldown: how long a down endpoint stays skipped before one trial re-checks it.
     */
    inference_first_token_timeout_ms: { type: Number, default: null },
    inference_health_poll_interval_ms: { type: Number, default: null },
    inference_health_failure_threshold: { type: Number, default: null },
    inference_health_cooldown_ms: { type: Number, default: null },
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
     * Who reads a screen for the GUI-control tools (`visual_*`, `android_*`) — see
     * `VISUAL_MODAL_PLAN.md`. `legacy`: the Vision endpoint above reads/locates and the agent works
     * from its prose. `modal`: the agent's own multimodal model receives the frame as pixels and
     * points at it itself (no second model, no grid-fraction prompt, no calibration). `auto`
     * (default): modal for a vision-capable agent, legacy otherwise — so a mixed fleet needs no
     * per-agent config.
     */
    screen_control_mode: { type: String, enum: ['auto', 'modal', 'legacy'], default: 'auto' },
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
    /**
     * ComfyUI server backing the media tools (`generate_image`, `generate_video`, `generate_sound`,
     * `edit_image`). Base URL only, no trailing slash and no `/api` — the client appends the routes.
     * Empty → every media tool reports it's unconfigured. Falls back to the `COMFY_URL` env var.
     */
    comfy_url: { type: String, default: '' },
    /**
     * Refuse to submit a media job when ComfyUI already has this many items queued. ComfyUI runs one
     * job at a time, so joining a deep queue means an agent blocks for the sum of everything ahead of
     * it. 0 disables the check.
     */
    comfy_queue_max: { type: Number, default: 3 },
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
     * Fleet-wide ceiling on `ask_agent` delegation depth (spec §4). The directly-addressed agent runs
     * at depth 0, so N allows a chain N hops deep. Guards against runaway recursion between agents;
     * raise it when a flow legitimately needs a longer chain (an orchestrator delegating to a worker
     * that in turn consults a verifier already spends two). Falls back to the `MAX_AGENT_HOPS` env
     * var when unset.
     */
    max_agent_hops: { type: Number, default: null },
    /**
     * Fleet-wide AGENTS.md — house rules injected into *every* agent's system prompt (subagents
     * included) as a read-only block. Operator-owned: no tool writes it. Per-agent standing
     * instructions live in `agent.agents_md`; the agent's own writable doc is `agent.notebook`.
     */
    agents_md: { type: String, default: '' },
    /**
     * Global inference modes (`MODES_PLAN.md`): prompt snippets offered in *every* conversation,
     * whatever endpoint and model it runs on, alongside the per-model modes defined on the endpoint.
     * Prompt-only by construction — a sampler tuned for one model says nothing about the next one.
     */
    global_modes: { type: [GlobalModeSchema], default: [] },
    /**
     * Built-in modes the operator has switched off. The built-ins themselves are code-defined and
     * never stored (see `builtin-modes.ts`), so "off" cannot live on the mode — it lives here, as a
     * list of their ids. A choice about which chips the composer offers, not an edit to the mode.
     */
    global_modes_disabled: { type: [String], default: [] },
    /**
     * Built-in modes the operator made **standing** (`default_on`). Same reason as
     * `global_modes_disabled`: a built-in has no database row to carry the flag, and making one
     * standing is a choice about this install rather than an edit to the app's wording. The
     * operator's own global modes carry `default_on` on the record itself.
     */
    global_modes_default_on: { type: [String], default: [] },
    /**
     * Memory distillation (`docs/memory-souvenirs.md`). When on, a completed turn is passed back
     * through the agent's *own* model, which writes 0..N standalone memories instead of the raw
     * transcript being dumped into Qdrant verbatim. Costs one short extra completion per turn, so
     * it is a switch; off means the agent only remembers what it deliberately saves via `remember`.
     */
    /**
     * Forum auto-reply (`FORUM_PLAN.md` §11.6): an @-mention of an agent runs it by itself, and the
     * answer goes back to the thread with no operator in the loop. Off by default — turning a board
     * where agents address each other into a self-driving one is a decision, not a default.
     *
     * The per-thread budget is what stops two agents paging each other forever: a thread may spend
     * at most this many automatic runs *within a rolling window*, after which its mentions queue up
     * as ordinary pending ones for the operator to run by hand.
     *
     * The window is what keeps the budget a brake rather than a lifespan. Counted over all time, a
     * thread meant to live for weeks — a project hub coordinating a build — spends its last unit one
     * afternoon and from then on silently wakes nobody, which looks exactly like the project having
     * stalled on its own. A runaway exchange burns 20 runs in minutes and is stopped just as hard;
     * a slow one gets its allowance back tomorrow. Set the window to 0 for the old lifetime cap.
     */
    forum_auto_reply: { type: Boolean, default: false },
    forum_auto_reply_max_per_thread: { type: Number, default: 8 },
    forum_auto_reply_window_hours: { type: Number, default: 24 },
    /**
     * The work board (spec `FORUM_WORKBOARD_PLAN.md`): whether the scheduler dispatches tasks.
     *
     * Off by default and off on upgrade, exactly as `forum_auto_reply` shipped. Turning it on with
     * no plans filed does nothing at all, which is the property that makes it safe to deploy — and
     * a plan stays `draft` until the operator starts it, so enabling this cannot set a half-read
     * plan running either.
     */
    forum_board_enabled: { type: Boolean, default: false },
    /**
     * Names of the shipped API presets (`domain/apis/builtin-catalogue.ts`) that have already been
     * offered to this instance. Boot installs only what is *not* in this list, so deleting a preset
     * makes it stay deleted while a preset added in a later release still arrives on its own.
     */
    api_builtins_installed: { type: [String], default: [] },
    /**
     * Minutes between scheduler ticks. A tick reaps finished dispatches, computes the ready set and
     * dispatches at most `forum_max_parallel` turns, so this is the board's real clock rate. Short
     * is safe here in a way it never was for the sweeper: a tick with nothing ready does no
     * inference and costs one indexed find per running plan.
     */
    forum_tick_interval_minutes: { type: Number, default: 2 },
    /**
     * How many task turns may be in flight at once, fleet-wide.
     *
     * 1 because this fleet has one inference endpoint. Raising it is correct only when that endpoint
     * serves concurrent streams — otherwise the scheduler cheerfully dispatches four turns into a
     * queue of one and every one of them counts against the plan's leash while it waits.
     */
    forum_max_parallel: { type: Number, default: 1 },
    /**
     * How many times a task may be dispatched and come back with nothing before it is `blocked` for
     * the manager to look at. The circuit breaker for a task an agent cannot do — without it, an
     * impossible task is re-dispatched every tick until the plan's whole allowance is gone.
     */
    forum_task_max_dispatches: { type: Number, default: 3 },
    /**
     * How many times a review may bounce a task back before the manager decides instead. Two agents
     * disagreeing about what "done" means do not converge by repeating themselves at each other.
     */
    forum_task_max_review_rounds: { type: Number, default: 2 },
    /**
     * Agent turns a project may spend across its whole life — work, review and manager turns alike.
     * Seeded onto the plan at creation and raisable there per project, so lifting the fleet default
     * does not silently restart a project the operator let run out on purpose.
     */
    forum_plan_max_turns: { type: Number, default: 60 },
    /** How many times the manager may revise one plan before it stops and asks the operator. */
    forum_plan_max_revisions: { type: Number, default: 6 },
    /**
     * The agent that plans projects and is called when one hits a problem. Resolved by name; empty
     * falls back to an agent called `project_manager` if the fleet has one. Deliberately an ordinary
     * operator-owned agent rather than a built-in like `forum_keeper` — a moderator's powers had to
     * be authorised in code, while a planner's entire output is task documents the operator reads.
     */
    forum_project_manager_agent: { type: String, default: '' },
    /**
     * Whether agent posts are held to their kind's shape and ceiling (spec §4). On by default: this
     * is the guard that runs *before* a turn is spent, and switching it off restores the world where
     * a status update can be three thousand characters of restatement.
     */
    forum_post_contract_enabled: { type: Boolean, default: true },
    /**
     * Automatic mention runs a *project* may spend per window, when its threads name a hub thread.
     *
     * Retained for threads outside a plan: a plan has its own leash (`forum_plans.turns_max`), which
     * counts agent turns rather than mention runs and is the number the operator raises for a
     * project. This governs the hub/child shape that predates plans and still works.
     */
    forum_auto_reply_max_per_project: { type: Number, default: 40 },
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
    /**
     * How many samples of history are kept per machine, in RAM (clamped to 60…100000 by the poller).
     * 720 ≈ 2h at the default 10s poll. The cost is roughly 200 bytes per sample per machine —
     * Settings → Monitor shows the live figure.
     */
    monitor_history_samples: { type: Number, default: 720 },
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
