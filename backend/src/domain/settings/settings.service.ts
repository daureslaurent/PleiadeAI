import { env } from '../../config/env';
import { SettingsModel } from './settings.model';

/** Effective inference settings the rest of the app reads. */
export interface EffectiveSettings {
  llama_url: string;
  llama_model: string;
  llama_api_key: string;
  max_tokens: number;
  context_window: number;
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
  /** Host self-update master switch — gates the "Update app" action + the periodic check. */
  update_enabled: boolean;
  /** How often the backend triggers a read-only host update check (git fetch + compare). */
  update_check_interval_hours: number;
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
      temperature: doc?.temperature ?? 0.7,
      top_p: doc?.top_p ?? 0.95,
      embedding_url: doc?.embedding_url || env.EMBEDDING_API_URL,
      embedding_model: doc?.embedding_model || env.EMBEDDING_MODEL,
      embedding_api_key: doc?.embedding_api_key || env.EMBEDDING_API_KEY,
      title_endpoint_id: doc?.title_endpoint_id ?? '',
      title_model: doc?.title_model ?? '',
      title_max_tokens: doc?.title_max_tokens ?? 256,
      update_enabled: doc?.update_enabled ?? false,
      update_check_interval_hours: doc?.update_check_interval_hours ?? 1,
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
