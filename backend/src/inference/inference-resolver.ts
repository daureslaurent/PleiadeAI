import { endpointRepository } from '../domain/endpoints/endpoint.repository';
import { settingsService } from '../domain/settings/settings.service';
import type { AgentDoc } from '../domain/agents/agent.model';

/** Fully-resolved inference target for one agent's turn: where to send, which model, how to sample. */
export interface ResolvedInference {
  url: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  topP: number;
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
  const contextWindow = endpoint?.context_window || settings.context_window;

  return {
    url,
    apiKey,
    model,
    contextWindow,
    maxTokens: settings.max_tokens,
    temperature: settings.temperature,
    topP: settings.top_p,
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
  return {
    url: endpoint.base_url,
    apiKey: endpoint.api_key,
    model: modelOverride || endpoint.default_model || endpoint.models?.[0] || settings.llama_model,
    contextWindow: endpoint.context_window || settings.context_window,
    maxTokens: settings.max_tokens,
    temperature: settings.temperature,
    topP: settings.top_p,
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
    .map((ep) => ({
      url: ep.base_url,
      apiKey: ep.api_key,
      // A smaller fallback model rarely matches the agent's chosen model name, so use the fallback
      // endpoint's own default (then its first discovered model, then the global default).
      model: ep.default_model || ep.models?.[0] || settings.llama_model,
      contextWindow: ep.context_window || settings.context_window,
      maxTokens: settings.max_tokens,
      temperature: settings.temperature,
      topP: settings.top_p,
    }));
}
