import { env } from '../../config/env';
import { SettingsModel } from './settings.model';

/** Effective inference settings the rest of the app reads. */
export interface EffectiveSettings {
  llama_url: string;
  llama_model: string;
  llama_api_key: string;
  max_tokens: number;
  context_window: number;
  /** Fleet default: auto-detect the context-meter max from each server's real n_ctx (else manual). */
  context_window_auto: boolean;
  temperature: number;
  top_p: number;
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
  /** Vision sampling params. `null` = disabled (not sent → server default); a number overrides it. */
  vision_temperature: number | null;
  vision_top_p: number | null;
  vision_max_tokens: number | null;
  vision_frequency_penalty: number | null;
  vision_presence_penalty: number | null;
  /** Image generation endpoint for `generate_image` ('' → the tool reports it's unconfigured). */
  image_endpoint_id: string;
  /** Model on `image_endpoint_id` for generation ('' → that endpoint's default). */
  image_model: string;
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
  /** Fleet default per-turn tool-round ceiling; an agent's own `max_tool_iterations` overrides it. */
  max_tool_iterations: number;
  /** Fleet-wide AGENTS.md house rules, injected read-only into every agent's prompt ('' → omitted). */
  agents_md: string;
}

const KEY = 'global';

/**
 * Resolves runtime settings, falling back to env defaults when no document (or field) is set.
 * `update` upserts the singleton so changes persist and take effect on the next inference call.
 */
export const settingsService = {
  async get(): Promise<EffectiveSettings> {
    const doc = await SettingsModel.findOne({ key: KEY }).lean();
    return {
      llama_url: doc?.llama_url ?? env.LLAMA_API_URL,
      llama_model: doc?.llama_model ?? env.LLAMA_MODEL,
      llama_api_key: doc?.llama_api_key ?? env.LLAMA_API_KEY,
      max_tokens: doc?.max_tokens ?? 2048,
      context_window: doc?.context_window ?? env.LLAMA_CONTEXT_WINDOW,
      context_window_auto: doc?.context_window_auto ?? true,
      temperature: doc?.temperature ?? 0.7,
      top_p: doc?.top_p ?? 0.95,
      embedding_url: doc?.embedding_url || env.EMBEDDING_API_URL,
      embedding_model: doc?.embedding_model || env.EMBEDDING_MODEL,
      embedding_api_key: doc?.embedding_api_key || env.EMBEDDING_API_KEY,
      title_endpoint_id: doc?.title_endpoint_id ?? '',
      title_model: doc?.title_model ?? '',
      title_max_tokens: doc?.title_max_tokens ?? 256,
      vision_endpoint_id: doc?.vision_endpoint_id ?? '',
      vision_model: doc?.vision_model ?? '',
      // `null` is meaningful here (= disabled), so only fall back to the default when the field is
      // truly absent (old doc / never set). `??` would wrongly turn an explicit null back into a value.
      vision_temperature: doc?.vision_temperature === undefined ? 0.2 : doc.vision_temperature,
      vision_top_p: doc?.vision_top_p === undefined ? null : doc.vision_top_p,
      vision_max_tokens: doc?.vision_max_tokens === undefined ? 1024 : doc.vision_max_tokens,
      vision_frequency_penalty:
        doc?.vision_frequency_penalty === undefined ? 0.4 : doc.vision_frequency_penalty,
      vision_presence_penalty:
        doc?.vision_presence_penalty === undefined ? 0.2 : doc.vision_presence_penalty,
      image_endpoint_id: doc?.image_endpoint_id ?? '',
      image_model: doc?.image_model ?? '',
      update_enabled: doc?.update_enabled ?? false,
      update_check_interval_hours: doc?.update_check_interval_hours ?? 1,
      scoring_enabled: doc?.scoring_enabled ?? false,
      scoring_endpoint_id: doc?.scoring_endpoint_id ?? '',
      scoring_model: doc?.scoring_model ?? '',
      scoring_max_tokens: doc?.scoring_max_tokens ?? 1024,
      max_tool_iterations: doc?.max_tool_iterations ?? 50,
      agents_md: doc?.agents_md ?? '',
    };
  },

  async update(patch: Partial<EffectiveSettings>): Promise<EffectiveSettings> {
    await SettingsModel.updateOne(
      { key: KEY },
      { $set: { key: KEY, ...patch } },
      { upsert: true },
    );
    return this.get();
  },
};
