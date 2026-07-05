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
    /** Exactly one endpoint is the default (used by agents that don't pick one). Enforced on write. */
    is_default: { type: Boolean, default: false },
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
