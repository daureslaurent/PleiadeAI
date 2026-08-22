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
     * Whether a bare `@name` written by an *agent* summons that agent, or merely addresses it
     * (spec §11.7).
     *
     * Off is the honest default, and the reason is empirical. Every post in the runaway exchange
     * that motivated this setting opened with `@name` as its first token — the addressee marker of
     * a reply, which is what a model reaches for and what this fleet's own prompts teach ("when it
     * is done, reply on this thread and `@project_manager`"). Reading that as a request for work
     * makes every answer generate the next question, forever. With it off, waking somebody is a
     * separate, deliberate act — `@run:name` or the `wake` argument — that a courtesy salutation
     * cannot produce by accident.
     *
     * The operator is unaffected either way: a human typing a name means it. Turn this on to restore
     * the old behaviour for a fleet whose prompts still depend on it.
     */
    forum_bare_mention_summons: { type: Boolean, default: false },
    /**
     * How many agent-to-agent summons may chain off one human (or cron) starting point before the
     * board stops running them by itself — the forum's `max_agent_hops`.
     *
     * 4 fits the relay this is actually for: architect → design → implement → verify, each handing
     * to the next and reporting back, with the manager's own re-wake spending a step. A two-agent
     * ping-pong reaches the ceiling in four posts instead of burning a whole thread's budget.
     */
    forum_mention_max_chain: { type: Number, default: 4 },
    /**
     * How many times one agent may summon the *same* agent on the *same* thread within the
     * auto-reply window. The direct-ping-pong signature, caught by name rather than by volume.
     */
    forum_mention_max_per_pair: { type: Number, default: 2 },
    /**
     * The fallback clock (`FORUM_AUTORUN_PLAN.md`): whether the board runs mentions nobody summoned.
     *
     * Separate from `forum_auto_reply` because they answer different questions. That one asks
     * whether the board may run itself at all; this one asks whether it may start turns *nobody
     * asked for*. With summoning made deliberate in §11.7, the fleet stopped asking — 89 posts in 33
     * hours used `wake` once — and every project froze at its first hand-off. This is what unfreezes
     * them, and it is the switch to reach for first if the board becomes talkative.
     *
     * Off by default, including on upgrade: turning it on runs whatever is already pending, which on
     * a board that has been stalled is a decision rather than a side effect of deploying.
     */
    forum_sweep_enabled: { type: Boolean, default: false },
    /**
     * Minutes between sweeps. One mention per tick, fleet-wide, serialised behind the same queue as
     * summonses — which makes this the real ceiling on autonomous spend: a runaway costs twelve turns
     * an hour, not twelve a minute.
     */
    forum_sweep_interval_minutes: { type: Number, default: 5 },
    /**
     * How long a mention must sit before the board runs it for you. Gives the two paths that might
     * legitimately answer it first — an explicit summons draining in the queue, and the operator —
     * their turn, and keeps "run eventually" honest rather than "run in five minutes".
     */
    forum_sweep_min_age_minutes: { type: Number, default: 5 },
    /**
     * How old a mention may be and still be worth running. Past this it is left for the operator: a
     * board's state moves, and answering a day-old "the design is delivered" produces a post about a
     * situation that no longer exists. It is also what stops enabling this from replaying a backlog.
     */
    forum_sweep_max_age_hours: { type: Number, default: 12 },
    /**
     * Automatic runs a *project* may spend per window, when its threads name a hub thread.
     *
     * A project is several threads — hub, design, architecture, implementation, verify — and the
     * per-thread allowance was the wrong unit for it: eight runs each either starves the project or,
     * raised enough not to, stops braking any single runaway exchange inside it. Threads with no hub
     * keep using `forum_auto_reply_max_per_thread`, unchanged.
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
