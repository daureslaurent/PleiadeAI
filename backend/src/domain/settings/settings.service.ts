import { env } from '../../config/env';
import { decryptSecret, encryptSecret } from '../../isolation/ssh.service';
import { SettingsModel } from './settings.model';
import type { GlobalMode } from '../endpoints/endpoint.model';
import { BUILTIN_GLOBAL_MODES } from './builtin-modes';
import type { CustomModule } from '../../modules/types';

/** How a screen is read for the GUI-control tools. See `VISUAL_MODAL_PLAN.md`. */
export const SCREEN_CONTROL_MODES = ['auto', 'modal', 'legacy'] as const;
export type ScreenControlMode = (typeof SCREEN_CONTROL_MODES)[number];

/**
 * Operator appearance (`THEME_SYSTEM_PLAN.md`). The backend never renders anything — it stores
 * these so the choice follows the operator to another browser, and validates them so a stale id
 * can't leave the UI with a `data-theme` nothing styles. The lists are duplicated from
 * `frontend/src/theme/{themes,layouts}.ts`; adding one means adding it in both places.
 */
export const UI_THEMES = ['pleiades', 'codex', 'terminal', 'paper', 'nebula'] as const;
export type UiTheme = (typeof UI_THEMES)[number];
export const UI_CHAT_LAYOUTS = ['hybrid', 'transcript', 'workbench', 'timeline', 'bubbles'] as const;
export type UiChatLayout = (typeof UI_CHAT_LAYOUTS)[number];

/** How a cloned repo authenticates inside an agent's container. */
export const GITLAB_GIT_TRANSPORTS = ['https', 'ssh'] as const;
export type GitLabGitTransport = (typeof GITLAB_GIT_TRANSPORTS)[number];

/** What becomes of an agent's GitLab user when the agent is deleted here. */
export const GITLAB_DELETE_ACTIONS = ['block', 'delete', 'nothing'] as const;
export type GitLabDeleteAction = (typeof GITLAB_DELETE_ACTIONS)[number];

/** Which agent a GitLab webhook about one project wakes when the event named nobody. */
export interface GitLabProjectAgent {
  project: string;
  agent_id: string;
}

/** Effective inference settings the rest of the app reads. */
export interface EffectiveSettings {
  /** Appearance the operator picked, echoed back to whichever browser asks. */
  ui_theme: UiTheme;
  ui_chat_layout: UiChatLayout;
  llama_url: string;
  llama_model: string;
  llama_api_key: string;
  max_tokens: number;
  context_window: number;
  /** Fleet default: auto-detect the context-meter max from each server's real n_ctx (else manual). */
  context_window_auto: boolean;
  temperature: number;
  top_p: number;
  /** Per-attempt time-to-first-token budget (ms); on timeout the turn fails over to the next endpoint. */
  inference_first_token_timeout_ms: number;
  /** How often the background health breaker probes every endpoint (ms). */
  inference_health_poll_interval_ms: number;
  /** Consecutive failures before an endpoint is parked down and skipped by routing. */
  inference_health_failure_threshold: number;
  /** How long a down endpoint stays excluded before one trial request may re-check it (ms). */
  inference_health_cooldown_ms: number;
  embedding_url: string;
  embedding_model: string;
  embedding_api_key: string;
  /** '' → use the responding agent's own endpoint+model for title generation; else a specific endpoint. */
  title_endpoint_id: string;
  /** Model on `title_endpoint_id` for titles ('' → that endpoint's default). Ignored when the id is ''. */
  title_model: string;
  /** Token budget for the title call — big enough to fit a reasoning model's `<think>` block + title. */
  title_max_tokens: number;
  /** Vision analysis endpoint for the visual tools ('' → vision analysis unavailable). */
  vision_endpoint_id: string;
  /** Model on `vision_endpoint_id` for screenshot analysis ('' → that endpoint's default). */
  vision_model: string;
  /**
   * Who reads a screen for the GUI-control tools: `legacy` (the Vision endpoint, returning prose),
   * `modal` (the calling agent's own multimodal model, receiving pixels), or `auto` — modal when the
   * agent supports vision, else legacy. See `VISUAL_MODAL_PLAN.md`.
   */
  screen_control_mode: ScreenControlMode;
  /** Vision sampling params. `null` = disabled (not sent → server default); a number overrides it. */
  vision_temperature: number | null;
  vision_top_p: number | null;
  vision_max_tokens: number | null;
  vision_frequency_penalty: number | null;
  vision_presence_penalty: number | null;
  /** ComfyUI base URL backing the media tools ('' → they report they're unconfigured). */
  comfy_url: string;
  /** Refuse a media job when ComfyUI already has this many queued (0 → no check). */
  comfy_queue_max: number;
  /** Host self-update master switch — gates the "Update app" action + the periodic check. */
  update_enabled: boolean;
  /** How often the backend triggers a read-only host update check (git fetch + compare). */
  update_check_interval_hours: number;
  /** Conversation Quality Scorer: auto-score each turn on completion. Off → only manual / batch scoring. */
  scoring_enabled: boolean;
  /** Judge endpoint for the LLM-as-judge ('' → reuse the responding agent's own endpoint). */
  scoring_endpoint_id: string;
  /** Model on `scoring_endpoint_id` for judging ('' → that endpoint's default). */
  scoring_model: string;
  /** Token budget for the judge reply — enough for a reasoning model's `<think>` + the JSON verdict. */
  scoring_max_tokens: number;
  /**
   * Overlap the parallel-safe calls of one model-emitted tool batch instead of running them in
   * sequence (`tools/parallel-safety.ts` decides which calls qualify).
   */
  tool_parallel_enabled: boolean;
  /** How many calls of a batch may be in flight at once; `0` means unlimited. */
  tool_parallel_max: number;
  /** Fleet default endpoint + model for `task` subagents (`SUBAGENT_PLAN.md`); '' = the agent's own. */
  subagent_endpoint_id: string;
  subagent_model: string;
  /** Most characters one subagent report may be. */
  subagent_report_max_chars: number;
  /** Fleet default per-turn tool-round ceiling; an agent's own `max_tool_iterations` overrides it. */
  max_tool_iterations: number;
  /** Ceiling on `ask_agent` delegation depth (depth 0 = the directly-addressed agent). */
  max_agent_hops: number;
  /** Fleet-wide AGENTS.md house rules, injected read-only into every agent's prompt ('' → omitted). */
  agents_md: string;
  /**
   * The module system (`MODULES_PLAN.md`). Ids of built-in modules the operator switched off, their
   * per-block wording overrides, and any modules the operator wrote themselves. Read on every turn
   * by `AgentRunner`, which is why they ride on the same document the turn already fetches.
   */
  modules_disabled: string[];
  /** Subagent-profile ids flipped away from each module's `subagentDefault`. */
  modules_disabled_subagent: string[];
  module_overrides: Record<string, Record<string, string>>;
  modules_custom: CustomModule[];
  /**
   * Fleet-wide prompt modes, offered in every conversation on top of the per-model endpoint ones:
   * the app's own built-ins first (marked, read-only, switched off via `global_modes_disabled`),
   * then the operator's own.
   */
  global_modes: GlobalMode[];
  /** Ids of built-in modes the operator switched off — the built-ins are code-defined, so "off" lives here. */
  global_modes_disabled: string[];
  /** Ids of built-in modes the operator made standing (on everywhere) — same reason they live here. */
  global_modes_default_on: string[];
  /**
   * Forum auto-reply: a *summons* of an agent on the forum runs it without the operator pressing
   * Run, and the answer is posted back to the thread. Off → a mention only ever raises an alert.
   */
  forum_auto_reply: boolean;
  /** Ceiling on how many automatic runs one thread may spend before it falls back to manual Run. */
  forum_auto_reply_max_per_thread: number;
  /** Length of the rolling window that ceiling is measured over. 0 → a lifetime cap, never reset. */
  forum_auto_reply_window_hours: number;
  /** Whether agent posts are held to their kind's shape and ceiling. */
  forum_post_contract_enabled: boolean;
  /** Automatic runs a project may spend per window, shared by every thread naming the same hub. */
  forum_auto_reply_max_per_project: number;
  /**
   * Post-turn memory distillation: the agent's own model rewrites a completed turn into 0..N
   * standalone memories instead of the raw transcript being embedded verbatim. See
   * `docs/memory-souvenirs.md`. Off → the agent only remembers what it saves via `remember`.
   */
  memory_distill_enabled: boolean;
  memory_max_tokens: number;
  /**
   * The autonomous run lane (`RUN_QUEUE_PLAN.md`). Paused, nothing new starts — whatever is running
   * finishes. On the settings singleton rather than in memory precisely because the reason to pause
   * is usually a restart of the inference server.
   */
  run_queue_paused: boolean;

  /** How this instance is reached from a browser (e.g. `https://pleiades.example.com`) — the base of the OAuth redirect URI. */
  /**
   * **GitLab** (`GITLAB_PLAN.md`). The three secrets are *not* here — they are `select: false` on
   * the document and reachable only through `gitlabSecrets()`, so an ordinary settings read (which
   * the whole app makes, and which the browser receives) cannot carry the fleet's git credential.
   * What the UI needs instead is whether each one is set.
   */
  gitlab_url: string;
  gitlab_group: string;
  gitlab_bot_username: string;
  gitlab_default_agent_id: string;
  gitlab_project_agents: GitLabProjectAgent[];
  gitlab_wake_issues: boolean;
  gitlab_wake_reviews: boolean;
  /** Polling (`GITLAB_PLAN.md` §13) — waking agents on an instance with no webhooks. */
  gitlab_poll_enabled: boolean;
  gitlab_poll_interval_minutes: number;
  /** Armed catalogue ids (`gitlab-poll.catalogue.ts`). Empty → the poller fetches nothing. */
  gitlab_poll_events: string[];
  gitlab_poll_projects: string[];
  gitlab_poll_max_wakes: number;
  gitlab_git_transport: GitLabGitTransport;
  gitlab_ssh_host: string;
  gitlab_ssh_port: number;
  /** Days of silence after which the project check calls an assigned issue or an open MR stale. */
  gitlab_stale_days: number;
  /** Give an agent its own GitLab identity the first time it needs one (`GITLAB_PLAN.md` §11). */
  gitlab_auto_provision: boolean;
  /** Access level new agent users get in the group. 30 = Developer. */
  gitlab_member_access_level: number;
  gitlab_on_agent_delete: GitLabDeleteAction;
  gitlab_user_email_domain: string;
  /** Derived, read-only: whether a provisioning admin token is stored. */
  gitlab_admin_token_set: boolean;
  /** Derived, read-only: never written back by `update`. */
  gitlab_token_set: boolean;
  gitlab_ssh_key_set: boolean;
  gitlab_webhook_secret_set: boolean;
  public_base_url: string;
  /** Google Cloud OAuth client for linking Gmail mailboxes ('' → mail linking unconfigured). */
  google_client_id: string;
  google_client_secret: string;
  /** Telegram bot token for alerts + the interactive bot ('' in DB → TELEGRAM_BOT_TOKEN env). */
  telegram_bot_token: string;
  /** Comma list of chat ids that receive alerts / may talk to the bot ('' in DB → env). */
  telegram_chat_ids: string;
  /** How often the Monitor poller reads every enabled target, seconds. */
  monitor_poll_seconds: number;
  /** Samples of history kept per machine in RAM (clamped 60…100000). 720 ≈ 2h at a 10s poll. */
  monitor_history_samples: number;
  /** Whether breached monitor thresholds fan out to the inbox + Telegram (the dashboard tints regardless). */
  monitor_alerts_enabled: boolean;
  /** Monitor thresholds, percent (memory/vram/disk) or °C (temps). `warn` = amber, `critical` = red. */
  monitor_cpu_temp_warn: number;
  monitor_cpu_temp_critical: number;
  monitor_gpu_temp_warn: number;
  monitor_gpu_temp_critical: number;
  monitor_memory_warn: number;
  monitor_memory_critical: number;
  monitor_vram_warn: number;
  monitor_vram_critical: number;
  monitor_disk_warn: number;
  monitor_disk_critical: number;
  /** Minutes before the same breach on the same target may alert again. */
  monitor_alert_cooldown_minutes: number;
}

const KEY = 'global';

/**
 * Resolves runtime settings, falling back to env defaults when no document (or field) is set.
 * `update` upserts the singleton so changes persist and take effect on the next inference call.
 */
export const settingsService = {
  async get(): Promise<EffectiveSettings> {
    // The three GitLab secrets are `select: false`, so they are asked for by name here — not to
    // return them (they never leave `gitlabSecrets`), but so this one read can report whether each
    // is set without a second round trip on a query the app makes every turn.
    const doc = await SettingsModel.findOne({ key: KEY })
      .select('+gitlab_token_enc +gitlab_webhook_secret_enc +gitlab_ssh_key_enc +gitlab_admin_token_enc')
      .lean();
    const secrets = {
      token: doc?.gitlab_token_enc ?? '',
      webhookSecret: doc?.gitlab_webhook_secret_enc ?? '',
      sshKey: doc?.gitlab_ssh_key_enc ?? '',
      adminToken: doc?.gitlab_admin_token_enc ?? '',
    };
    const disabled = (doc?.global_modes_disabled as string[] | undefined) ?? [];
    const standing = (doc?.global_modes_default_on as string[] | undefined) ?? [];
    return {
      llama_url: doc?.llama_url ?? env.LLAMA_API_URL,
      llama_model: doc?.llama_model ?? env.LLAMA_MODEL,
      llama_api_key: doc?.llama_api_key ?? env.LLAMA_API_KEY,
      max_tokens: doc?.max_tokens ?? 2048,
      context_window: doc?.context_window ?? env.LLAMA_CONTEXT_WINDOW,
      context_window_auto: doc?.context_window_auto ?? true,
      temperature: doc?.temperature ?? 0.7,
      top_p: doc?.top_p ?? 0.95,
      inference_first_token_timeout_ms:
        doc?.inference_first_token_timeout_ms ?? env.INFERENCE_FIRST_TOKEN_TIMEOUT_MS,
      inference_health_poll_interval_ms:
        doc?.inference_health_poll_interval_ms ?? env.INFERENCE_HEALTH_POLL_INTERVAL_MS,
      inference_health_failure_threshold:
        doc?.inference_health_failure_threshold ?? env.INFERENCE_HEALTH_FAILURE_THRESHOLD,
      inference_health_cooldown_ms:
        doc?.inference_health_cooldown_ms ?? env.INFERENCE_HEALTH_COOLDOWN_MS,
      embedding_url: doc?.embedding_url || env.EMBEDDING_API_URL,
      embedding_model: doc?.embedding_model || env.EMBEDDING_MODEL,
      embedding_api_key: doc?.embedding_api_key || env.EMBEDDING_API_KEY,
      title_endpoint_id: doc?.title_endpoint_id ?? '',
      title_model: doc?.title_model ?? '',
      title_max_tokens: doc?.title_max_tokens ?? 256,
      vision_endpoint_id: doc?.vision_endpoint_id ?? '',
      vision_model: doc?.vision_model ?? '',
      screen_control_mode: SCREEN_CONTROL_MODES.includes(doc?.screen_control_mode as ScreenControlMode)
        ? (doc!.screen_control_mode as ScreenControlMode)
        : 'auto',
      ui_theme: UI_THEMES.includes(doc?.ui_theme as UiTheme) ? (doc!.ui_theme as UiTheme) : 'pleiades',
      ui_chat_layout: UI_CHAT_LAYOUTS.includes(doc?.ui_chat_layout as UiChatLayout)
        ? (doc!.ui_chat_layout as UiChatLayout)
        : 'hybrid',
      // `null` is meaningful here (= disabled), so only fall back to the default when the field is
      // truly absent (old doc / never set). `??` would wrongly turn an explicit null back into a value.
      vision_temperature: doc?.vision_temperature === undefined ? 0.2 : doc.vision_temperature,
      vision_top_p: doc?.vision_top_p === undefined ? null : doc.vision_top_p,
      vision_max_tokens: doc?.vision_max_tokens === undefined ? 1024 : doc.vision_max_tokens,
      vision_frequency_penalty:
        doc?.vision_frequency_penalty === undefined ? 0.4 : doc.vision_frequency_penalty,
      vision_presence_penalty:
        doc?.vision_presence_penalty === undefined ? 0.2 : doc.vision_presence_penalty,
      // `||` (not `??`): an empty stored URL means "unset", so the env default still applies.
      comfy_url: doc?.comfy_url || env.COMFY_URL,
      comfy_queue_max: doc?.comfy_queue_max ?? 3,
      update_enabled: doc?.update_enabled ?? false,
      update_check_interval_hours: doc?.update_check_interval_hours ?? 1,
      scoring_enabled: doc?.scoring_enabled ?? false,
      scoring_endpoint_id: doc?.scoring_endpoint_id ?? '',
      scoring_model: doc?.scoring_model ?? '',
      scoring_max_tokens: doc?.scoring_max_tokens ?? 1024,
      tool_parallel_enabled: doc?.tool_parallel_enabled ?? true,
      tool_parallel_max: doc?.tool_parallel_max ?? 4,
      subagent_endpoint_id: doc?.subagent_endpoint_id ?? '',
      subagent_model: doc?.subagent_model ?? '',
      subagent_report_max_chars: doc?.subagent_report_max_chars ?? 6000,
      max_tool_iterations: doc?.max_tool_iterations ?? 50,
      max_agent_hops: doc?.max_agent_hops ?? env.MAX_AGENT_HOPS,
      agents_md: doc?.agents_md ?? '',
      modules_disabled: (doc?.modules_disabled as string[] | undefined) ?? [],
      modules_disabled_subagent: (doc?.modules_disabled_subagent as string[] | undefined) ?? [],
      module_overrides:
        (doc?.module_overrides as Record<string, Record<string, string>> | undefined) ?? {},
      modules_custom: (doc?.modules_custom as CustomModule[] | undefined) ?? [],
      // Built-ins are composed in on every read rather than seeded once, so they improve with the
      // app instead of staying frozen at whatever a migration wrote. A disabled one is still
      // returned (the Settings page has to render its row) but marked so nothing offers it in chat.
      global_modes: [
        ...BUILTIN_GLOBAL_MODES.map((m) => ({
          ...m,
          enabled: !disabled.includes(m.id),
          default_on: standing.includes(m.id),
        })),
        ...((doc?.global_modes as GlobalMode[] | undefined) ?? []),
      ],
      global_modes_disabled: disabled,
      global_modes_default_on: standing,
      forum_auto_reply: doc?.forum_auto_reply ?? false,
      forum_auto_reply_max_per_thread: doc?.forum_auto_reply_max_per_thread ?? 8,
      forum_auto_reply_window_hours: doc?.forum_auto_reply_window_hours ?? 24,
      forum_post_contract_enabled: doc?.forum_post_contract_enabled ?? true,
      forum_auto_reply_max_per_project: doc?.forum_auto_reply_max_per_project ?? 40,
      memory_distill_enabled: doc?.memory_distill_enabled ?? true,
      memory_max_tokens: doc?.memory_max_tokens ?? 800,
      run_queue_paused: doc?.run_queue_paused ?? false,
      gitlab_url: doc?.gitlab_url ?? '',
      gitlab_group: doc?.gitlab_group ?? '',
      gitlab_bot_username: doc?.gitlab_bot_username ?? '',
      gitlab_default_agent_id: doc?.gitlab_default_agent_id ?? '',
      gitlab_project_agents: (doc?.gitlab_project_agents as GitLabProjectAgent[] | undefined) ?? [],
      gitlab_wake_issues: doc?.gitlab_wake_issues ?? false,
      gitlab_wake_reviews: doc?.gitlab_wake_reviews ?? false,
      gitlab_poll_enabled: doc?.gitlab_poll_enabled ?? false,
      gitlab_poll_interval_minutes: doc?.gitlab_poll_interval_minutes ?? 5,
      gitlab_poll_events: (doc?.gitlab_poll_events as string[] | undefined) ?? [],
      gitlab_poll_projects: (doc?.gitlab_poll_projects as string[] | undefined) ?? [],
      gitlab_poll_max_wakes: doc?.gitlab_poll_max_wakes ?? 5,
      gitlab_git_transport: (doc?.gitlab_git_transport as GitLabGitTransport | undefined) ?? 'https',
      gitlab_ssh_host: doc?.gitlab_ssh_host ?? '',
      gitlab_ssh_port: doc?.gitlab_ssh_port ?? 22,
      gitlab_stale_days: doc?.gitlab_stale_days ?? 3,
      gitlab_auto_provision: doc?.gitlab_auto_provision ?? true,
      gitlab_member_access_level: doc?.gitlab_member_access_level ?? 30,
      gitlab_on_agent_delete: (doc?.gitlab_on_agent_delete as GitLabDeleteAction | undefined) ?? 'block',
      gitlab_user_email_domain: doc?.gitlab_user_email_domain ?? '',
      gitlab_admin_token_set: !!secrets.adminToken,
      // Presence only. `gitlabSecrets()` is the one path that reads the values themselves.
      gitlab_token_set: !!secrets.token,
      gitlab_ssh_key_set: !!secrets.sshKey,
      gitlab_webhook_secret_set: !!secrets.webhookSecret,
      public_base_url: doc?.public_base_url ?? '',
      google_client_id: doc?.google_client_id ?? '',
      google_client_secret: doc?.google_client_secret ?? '',
      // `||` (not `??`): an empty DB string means "unset" and falls back to the env defaults.
      telegram_bot_token: doc?.telegram_bot_token || env.TELEGRAM_BOT_TOKEN || '',
      telegram_chat_ids:
        doc?.telegram_chat_ids || env.TELEGRAM_ALLOWED_CHAT_IDS || env.TELEGRAM_CHAT_ID || '',
      monitor_poll_seconds: doc?.monitor_poll_seconds ?? 10,
      monitor_history_samples: doc?.monitor_history_samples ?? 720,
      monitor_alerts_enabled: doc?.monitor_alerts_enabled ?? true,
      monitor_cpu_temp_warn: doc?.monitor_cpu_temp_warn ?? 80,
      monitor_cpu_temp_critical: doc?.monitor_cpu_temp_critical ?? 90,
      monitor_gpu_temp_warn: doc?.monitor_gpu_temp_warn ?? 80,
      monitor_gpu_temp_critical: doc?.monitor_gpu_temp_critical ?? 88,
      monitor_memory_warn: doc?.monitor_memory_warn ?? 85,
      monitor_memory_critical: doc?.monitor_memory_critical ?? 95,
      monitor_vram_warn: doc?.monitor_vram_warn ?? 90,
      monitor_vram_critical: doc?.monitor_vram_critical ?? 97,
      monitor_disk_warn: doc?.monitor_disk_warn ?? 85,
      monitor_disk_critical: doc?.monitor_disk_critical ?? 95,
      monitor_alert_cooldown_minutes: doc?.monitor_alert_cooldown_minutes ?? 30,
    };
  },

  /**
   * The GitLab credentials in plaintext — the *only* path to them.
   *
   * Kept off `EffectiveSettings` on purpose: that object is handed to the browser by
   * `GET /api/settings` and read by every turn, and a credential that can merge into any repository
   * in the instance has no business riding along with the temperature.
   */
  async gitlabSecrets(): Promise<{
    token: string;
    webhookSecret: string;
    sshKey: string;
    adminToken: string;
  }> {
    const doc = await SettingsModel.findOne({ key: KEY })
      .select('+gitlab_token_enc +gitlab_webhook_secret_enc +gitlab_ssh_key_enc +gitlab_admin_token_enc')
      .lean();
    const open = (payload?: string): string => {
      if (!payload) return '';
      try {
        return decryptSecret(payload);
      } catch {
        // A key rotation (or a restore onto a fresh `.env`) leaves undecryptable ciphertext. Report
        // it as "unset" — the operator re-pastes it — rather than throwing on every settings read.
        return '';
      }
    };
    return {
      token: open(doc?.gitlab_token_enc),
      webhookSecret: open(doc?.gitlab_webhook_secret_enc),
      sshKey: open(doc?.gitlab_ssh_key_enc),
      adminToken: open(doc?.gitlab_admin_token_enc),
    };
  },

  /** Store (or clear, on '') one GitLab secret, encrypted at rest. */
  async setGitlabSecret(
    field: 'token' | 'webhookSecret' | 'sshKey' | 'adminToken',
    plaintext: string,
  ): Promise<void> {
    const key = {
      token: 'gitlab_token_enc',
      webhookSecret: 'gitlab_webhook_secret_enc',
      sshKey: 'gitlab_ssh_key_enc',
      adminToken: 'gitlab_admin_token_enc',
    }[field];
    await SettingsModel.updateOne(
      { key: KEY },
      { $set: { key: KEY, [key]: plaintext ? encryptSecret(plaintext) : '' } },
      { upsert: true },
    );
  },

  async update(patch: Partial<EffectiveSettings>): Promise<EffectiveSettings> {
    // `gitlab_*_set` are derived from the encrypted fields on read. A caller round-tripping a whole
    // settings object (`update(await get())`) would otherwise persist the booleans as real columns
    // that then never change — the presence flags must stay a function of the ciphertext.
    const {
      gitlab_token_set,
      gitlab_ssh_key_set,
      gitlab_webhook_secret_set,
      gitlab_admin_token_set,
      ...storable
    } = patch;
    void gitlab_token_set, gitlab_ssh_key_set, gitlab_webhook_secret_set, gitlab_admin_token_set;
    await SettingsModel.updateOne(
      { key: KEY },
      { $set: { key: KEY, ...storable } },
      { upsert: true },
    );
    return this.get();
  },
};
