import { endpointRepository } from '../domain/endpoints/endpoint.repository';
import { settingsService } from '../domain/settings/settings.service';
import type { AgentDoc } from '../domain/agents/agent.model';
import type { EndpointDoc } from '../domain/endpoints/endpoint.model';

/**
 * The probed real context size for a specific model on this endpoint (`n_ctx`), or `0` if we never
 * probed it. `model_contexts` is a Mongoose `Map`, but a lean/plain read yields an object — handle
 * both. Takes precedence over the manually-typed `context_window` when present.
 */
function modelContext(endpoint: EndpointDoc | null, model: string): number {
  const mc = endpoint?.model_contexts as unknown;
  if (!mc || !model) return 0;
  const raw =
    typeof (mc as { get?: (k: string) => unknown }).get === 'function'
      ? (mc as { get: (k: string) => unknown }).get(model)
      : (mc as Record<string, unknown>)[model];
  return typeof raw === 'number' && raw > 0 ? raw : 0;
}

/**
 * The context-meter max for a turn. Auto (per-endpoint `context_window_mode`, else the global
 * `context_window_auto` default) uses the server's probed real n_ctx for this model, falling back to
 * the manual number when nothing was probed. Manual uses the endpoint's typed value, then the global.
 */
function resolveContextWindow(
  endpoint: EndpointDoc | null,
  model: string,
  settings: { context_window: number; context_window_auto: boolean },
): number {
  const manual = endpoint?.context_window || settings.context_window;
  const mode = endpoint?.context_window_mode;
  const auto = mode === 'auto' || (mode !== 'manual' && settings.context_window_auto);
  return auto ? modelContext(endpoint, model) || manual : manual;
}

/** Fully-resolved inference target for one agent's turn: where to send, which model, how to sample. */
export interface ResolvedInference {
  url: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  /** Operator-declared: this endpoint's model is multimodal (vision). Advisory only. */
  supportsVision: boolean;
}

/**
 * Resolve the endpoint + model an agent should use this turn, layering global sampling settings
 * on top. Precedence: the agent's assigned endpoint → the default endpoint → the legacy global
 * settings connection. The model follows the agent's pick, then the endpoint's first discovered
 * model, then the global default model. Sampling always comes from global settings.
 */
export async function resolveInference(agent: Pick<AgentDoc, 'endpoint_id' | 'model'>): Promise<ResolvedInference> {
  const settings = await settingsService.get();
  const endpoint = agent.endpoint_id
    ? await endpointRepository.findById(agent.endpoint_id)
    : await endpointRepository.findDefault();

  const url = endpoint?.base_url ?? settings.llama_url;
  const apiKey = endpoint?.api_key ?? settings.llama_api_key;
  const model =
    agent.model || endpoint?.default_model || endpoint?.models?.[0] || settings.llama_model;
  // Denominator for the context meter: auto → the server's probed real n_ctx; manual → the typed
  // value. Keeps the meter honest against the server's --ctx-size when auto-detection is on.
  const contextWindow = resolveContextWindow(endpoint, model, settings);

  return {
    url,
    apiKey,
    model,
    contextWindow,
    maxTokens: settings.max_tokens,
    temperature: settings.temperature,
    topP: settings.top_p,
    supportsVision: Boolean(endpoint?.supports_vision),
  };
}

/**
 * Resolve a specific endpoint (by id) into an inference target, layering global sampling on top.
 * `modelOverride` wins over the endpoint's own default model. Returns `null` if the endpoint is
 * gone (deleted after being selected). Used by side tasks that target a fixed endpoint, e.g. title
 * generation pointed at a cheap model.
 */
export async function resolveForEndpoint(
  endpointId: string,
  modelOverride?: string,
): Promise<ResolvedInference | null> {
  const endpoint = await endpointRepository.findById(endpointId);
  if (!endpoint) return null;
  const settings = await settingsService.get();
  const model = modelOverride || endpoint.default_model || endpoint.models?.[0] || settings.llama_model;
  return {
    url: endpoint.base_url,
    apiKey: endpoint.api_key,
    model,
    contextWindow: resolveContextWindow(endpoint, model, settings),
    maxTokens: settings.max_tokens,
    temperature: settings.temperature,
    topP: settings.top_p,
    supportsVision: Boolean(endpoint.supports_vision),
  };
}

/**
 * The ordered failover chain for a turn: every endpoint opted into fallback (`fallback_order > 0`),
 * lowest order first, each fully resolved with its own default model + the global sampling settings.
 * `excludeUrl` drops the primary target so we never immediately retry the box that just failed.
 * Returns `[]` when no fallbacks are configured (the normal single-endpoint case).
 */
export async function resolveFallbacks(excludeUrl?: string): Promise<ResolvedInference[]> {
  const fallbacks = await endpointRepository.listFallbacks();
  if (!fallbacks.length) return [];
  const settings = await settingsService.get();
  const norm = (u: string) => u.replace(/\/$/, '');

  return fallbacks
    .filter((ep) => !excludeUrl || norm(ep.base_url) !== norm(excludeUrl))
    .map((ep) => {
      // A smaller fallback model rarely matches the agent's chosen model name, so use the fallback
      // endpoint's own default (then its first discovered model, then the global default).
      const model = ep.default_model || ep.models?.[0] || settings.llama_model;
      return {
        url: ep.base_url,
        apiKey: ep.api_key,
        model,
        contextWindow: resolveContextWindow(ep, model, settings),
        maxTokens: settings.max_tokens,
        temperature: settings.temperature,
        topP: settings.top_p,
        supportsVision: Boolean(ep.supports_vision),
      };
    });
}
