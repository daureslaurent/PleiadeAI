import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * One mode. `params` holds only the sampling fields the operator actually set — a `null` (or absent)
 * field is never put on the wire, so the global setting / the server's own default stands. Stored as
 * `Mixed` so an unset sampler is genuinely absent rather than coerced to 0, which llama.cpp would
 * read as a real (and destructive) value.
 */
const ModeSchema = new Schema(
  {
    id: { type: String, required: true },
    /** The model id on this endpoint the mode belongs to. */
    model: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['sampling', 'prompt'], required: true },
    /** Unticked modes stay configured but are hidden from the composer. */
    enabled: { type: Boolean, default: true },
    /** `sampling` only: the subset of samplers this mode overrides. */
    params: { type: Schema.Types.Mixed, default: {} },
    /** `prompt` only: the text appended to the turn. */
    text: { type: String, default: '' },
    /**
     * `prompt` only: where the text lands. `user_suffix` is required by llama.cpp chat-template
     * control tokens (`/no_think`), which are only honoured on the user turn.
     */
    placement: { type: String, enum: ['system_suffix', 'user_suffix'], default: 'system_suffix' },
  },
  { _id: false },
);

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
     *
     * Stored as a plain object (not a Mongoose `Map`) because model ids can contain `.`
     * (e.g. `LFM2.5-8B-multi`), which `Map` forbids as a key — that rejection used to make the whole
     * discovery write throw. MongoDB stores dotted field names in a nested value fine, and we never
     * query into this object (only whole-object read + keyed lookup by real model id), so `Mixed` is safe.
     */
    model_contexts: { type: Schema.Types.Mixed, default: {} },
    /**
     * Operator-defined **modes** for the models on this endpoint (`MODES_PLAN.md`). A mode is either a
     * `sampling` preset (a subset of llama.cpp's samplers, applied over the global settings) or a
     * `prompt` snippet appended to the turn. Each entry names the model it belongs to, so a control
     * token only one family understands (`/no_think`) is never offered for another model. Empty by
     * default — an endpoint with no modes behaves exactly as it did before the feature existed.
     *
     * `id` is an explicit string rather than a subdocument `_id` because the UI saves the whole array
     * at once: Mongoose would re-mint `_id`s on every save and orphan the sessions referencing them.
     */
    modes: { type: [ModeSchema], default: [] },
    /** Exactly one endpoint is the default (used by agents that don't pick one). Enforced on write. */
    is_default: { type: Boolean, default: false },
    /**
     * Manual vision (multimodal) marker — the *fallback* when nothing was auto-detected. On llama.cpp
     * the probe reads `--mmproj` from the launch args (see `model_vision` below) and wins; this flag
     * only decides for servers that expose nothing decidable (vLLM, Ollama, older builds). The
     * effective reading gates whether images are attached to inference and drives the visual-agent
     * pairing warnings — resolve it via `effectiveVision()`, never read this field directly.
     */
    supports_vision: { type: Boolean, default: false },
    /**
     * Per-model auto-detected vision capability, keyed by model id, probed at model discovery
     * alongside `model_contexts` (`--mmproj` in `/v1/models` `status.args` on a router, `/props`
     * `modalities.vision` on a single-model server). `true`/`false` are confident readings that
     * override the manual `supports_vision`; a model absent from the map means "undetectable" and
     * falls back to the manual flag. Plain object (not a Mongoose `Map`) for the same dotted-model-id
     * reason as `model_contexts`.
     */
    model_vision: { type: Schema.Types.Mixed, default: {} },
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

/**
 * Whether `model` on this endpoint is vision-capable (multimodal): the auto-detected per-model
 * reading when the probe produced one, else the operator's manual `supports_vision` flag. This is
 * the single source of truth for "can I send images here" — the resolver, the health probe and the
 * UI all agree through it.
 */
export function effectiveVision(endpoint: Pick<Endpoint, 'model_vision' | 'supports_vision'> | null, model: string): boolean {
  if (!endpoint) return false;
  const detected = model ? (endpoint.model_vision as Record<string, unknown> | undefined)?.[model] : undefined;
  return typeof detected === 'boolean' ? detected : Boolean(endpoint.supports_vision);
}


/** The sampling fields a `sampling` mode may override, in the order the UI renders them. */
export const MODE_SAMPLERS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'repetition_penalty',
] as const;

export type ModeSampler = (typeof MODE_SAMPLERS)[number];

/** One operator-defined mode (`MODES_PLAN.md`). Mirrors `ModeSchema`. */
export interface EndpointMode {
  id: string;
  model: string;
  name: string;
  type: 'sampling' | 'prompt';
  enabled: boolean;
  params: Partial<Record<ModeSampler, number | null>>;
  text: string;
  placement: 'system_suffix' | 'user_suffix';
}

/**
 * The modes configured for `model` on this endpoint, enabled ones only. Ordering is the operator's
 * array order, which is also the order overlapping sampling fields resolve in (last wins).
 */
export function modesForModel(
  endpoint: Pick<Endpoint, 'modes'> | null,
  model: string,
): EndpointMode[] {
  if (!endpoint || !model) return [];
  return ((endpoint.modes ?? []) as unknown as EndpointMode[]).filter(
    (m) => m.enabled !== false && m.model === model,
  );
}

export const EndpointModel = model('Endpoint', EndpointSchema);
