import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `endpoints` collection. Each document is one OpenAI-compatible inference server (llama.cpp,
 * vLLM, Ollama, TGI, …). Agents point at an endpoint + model; when they don't, the single
 * `is_default` endpoint is used. Models are autodiscovered from the server's `GET /v1/models`
 * and cached here (`models` / `models_updated_at`) so the UI never has to hit the server live.
 */
const EndpointSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    /** OpenAI-compatible base, e.g. `http://192.168.1.20:8080` (the `/v1` suffix is added by the client). */
    base_url: { type: String, required: true },
    api_key: { type: String, default: 'sk-no-key-required' },
    /** Cached model ids reported by the server's `/v1/models` at the last discovery. */
    models: { type: [String], default: [] },
    models_updated_at: { type: Date, default: null },
    /**
     * Default model for this endpoint — used by agents assigned to it that don't pick a model
     * themselves. Empty falls back to the first discovered model. The `is_default` endpoint's
     * `default_model` is the fleet-wide default.
     */
    default_model: { type: String, default: '' },
    /**
     * Model context window (n_ctx) for this endpoint; only used to render session context usage as
     * a fraction. `0` means "fall back to the global settings' context_window".
     */
    context_window: { type: Number, default: 0 },
    /**
     * How this endpoint picks the context-meter max: `inherit` follows the global
     * `context_window_auto` default; `auto` uses the probed real n_ctx (`model_contexts`); `manual`
     * uses the typed `context_window` above. Auto falls back to the manual number if nothing was probed.
     */
    context_window_mode: { type: String, enum: ['inherit', 'auto', 'manual'], default: 'inherit' },
    /**
     * Per-model real context size (`n_ctx`), keyed by model id, probed from the server at model
     * discovery (`/props` runtime n_ctx, else `/v1/models` `meta.n_ctx_train`). This is the honest
     * ceiling the context meter renders against; it takes precedence over the manual `context_window`
     * above. Empty until the first discovery (then falls back to `context_window`/global settings).
     */
    model_contexts: { type: Map, of: Number, default: {} },
    /** Exactly one endpoint is the default (used by agents that don't pick one). Enforced on write. */
    is_default: { type: Boolean, default: false },
    /**
     * Operator marker: this endpoint's model is multimodal (vision), i.e. its llama.cpp was launched
     * with `--mmproj` (or it's a vision-capable vLLM/Ollama model). We can't autodiscover this from
     * `/v1/models`, so it's a manual flag. Used to warn when a *visual* agent (one whose isolation
     * image has the visual layer) is paired with a text-only endpoint — its screenshots would be
     * silently ignored. Purely advisory; it does not gate inference.
     */
    supports_vision: { type: Boolean, default: false },
    /**
     * Runtime failover position. `0` means this endpoint is *not* part of the fallback chain.
     * Endpoints with `fallback_order > 0` form the ordered chain the inference client walks (ascending)
     * when the primary target can't be reached — e.g. a local CPU llama.cpp container as a last resort.
     */
    fallback_order: { type: Number, default: 0 },
    /**
     * System-managed endpoint (the built-in local docker fallback). Ensured at boot with a forced
     * URL + auto-discovered model; the UI shows it as read-only and blocks deletion so it always
     * stays available as a last resort. Operators may still tweak its model / fallback position.
     */
    managed: { type: Boolean, default: false },
  },
  { collection: 'endpoints', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type Endpoint = InferSchemaType<typeof EndpointSchema>;
export type EndpointDoc = HydratedDocument<Endpoint>;

export const EndpointModel = model('Endpoint', EndpointSchema);
