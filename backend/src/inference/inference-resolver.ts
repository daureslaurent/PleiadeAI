import type { Types } from 'mongoose';
import { endpointRepository } from '../domain/endpoints/endpoint.repository';
import { settingsService } from '../domain/settings/settings.service';
import { effectiveVision, type EndpointDoc } from '../domain/endpoints/endpoint.model';
import { modePrompts, modeSampling, selectModes, type ModePrompts } from './modes';

/**
 * The probed real context size for a specific model on this endpoint (`n_ctx`), or `0` if we never
 * probed it. `model_contexts` is stored as a plain object (keyed by real model id, dots and all);
 * older docs may still hydrate as a Mongoose `Map`, so handle both `.get()` and object access.
 * Takes precedence over the manually-typed `context_window` when present.
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
  /**
   * Extra llama.cpp samplers, set only by an active `sampling` mode (`MODES_PLAN.md`). `null` means
   * "don't put this field on the wire" — the server keeps its own default, which is why they are
   * nullable rather than defaulted here.
   */
  topK: number | null;
  minP: number | null;
  presencePenalty: number | null;
  repetitionPenalty: number | null;
  /**
   * Operator text the active `prompt` modes append to this turn: `system` at the end of the single
   * leading system message, `user` at the end of the user turn. Empty on every turn with no modes.
   */
  promptSuffixes: ModePrompts;
  /**
   * The resolved model is multimodal (vision): auto-detected at model discovery (`--mmproj` in the
   * server's launch args), falling back to the endpoint's manual flag. Gates image attachment.
   */
  supportsVision: boolean;
  /** Fleet default per-turn tool-round ceiling; applies when the agent doesn't override it. */
  maxToolIterations: number;
}

/** No modes: the shape every non-mode caller (fallbacks, side tasks) resolves to. */
const NO_MODES: Pick<
  ResolvedInference,
  'topK' | 'minP' | 'presencePenalty' | 'repetitionPenalty' | 'promptSuffixes'
> = {
  topK: null,
  minP: null,
  presencePenalty: null,
  repetitionPenalty: null,
  promptSuffixes: { system: [], user: [] },
};

/**
 * Whose inference target to resolve. Structural rather than `Pick<AgentDoc, …>` so a caller with no
 * agent at all can ask for one by passing `{}`: side tasks such as the Conversation Generator's
 * interviewer deliberately run on the *fleet default* endpoint + model rather than any agent's.
 */
export interface InferenceTarget {
  endpoint_id?: Types.ObjectId | string | null;
  model?: string;
}

/**
 * Resolve the endpoint + model an agent should use this turn, layering global sampling settings
 * on top. Precedence: the agent's assigned endpoint → the default endpoint → the legacy global
 * settings connection. The model follows the agent's pick, then the endpoint's first discovered
 * model, then the global default model. Sampling comes from global settings, overridden field by
 * field by whichever of `modeIds` resolve to `sampling` modes on this endpoint's chosen model.
 */
export async function resolveInference(
  agent: InferenceTarget,
  modeIds?: readonly string[],
): Promise<ResolvedInference> {
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

  // Inference modes (`MODES_PLAN.md`): the operator's picks for this conversation, narrowed to the
  // ones on offer here — defined for the model we actually resolved, or global (prompt-only, so a
  // fleet-wide mode never claims a sampler value is right for every model). Sampling overrides layer on top of the global
  // settings; prompt suffixes ride along for the runner to fold into the messages.
  const modes = selectModes(endpoint, model, modeIds, settings.global_modes);
  const sampling = modeSampling(modes);

  return {
    url,
    apiKey,
    model,
    contextWindow,
    maxTokens: settings.max_tokens,
    temperature: sampling.temperature ?? settings.temperature,
    topP: sampling.topP ?? settings.top_p,
    topK: sampling.topK ?? null,
    minP: sampling.minP ?? null,
    presencePenalty: sampling.presencePenalty ?? null,
    repetitionPenalty: sampling.repetitionPenalty ?? null,
    promptSuffixes: modePrompts(modes),
    supportsVision: effectiveVision(endpoint, model),
    maxToolIterations: settings.max_tool_iterations,
  };
}

/**
 * Resolve a specific endpoint (by id) into an inference target, layering global sampling on top.
 * `modelOverride` wins over the endpoint's own default model. Returns `null` if the endpoint is
 * gone (deleted after being selected). Used by side tasks that target a fixed endpoint, e.g. title
 * generation pointed at a cheap model — side tasks run unmoded, since a mode is the operator's
 * choice for one *conversation*.
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
    ...NO_MODES,
    supportsVision: effectiveVision(endpoint, model),
    maxToolIterations: settings.max_tool_iterations,
  };
}

/**
 * The ordered failover chain for a turn: every endpoint opted into fallback (`fallback_order > 0`),
 * lowest order first, each fully resolved with its own default model + the global sampling settings.
 * `excludeUrl` drops the primary target so we never immediately retry the box that just failed.
 * Returns `[]` when no fallbacks are configured (the normal single-endpoint case).
 *
 * No modes here: a mode belongs to one model on one endpoint, and a failover target is by definition
 * a different box running a different model, so the operator's picks cannot be said to apply.
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
        ...NO_MODES,
        supportsVision: effectiveVision(ep, model),
        maxToolIterations: settings.max_tool_iterations,
      };
    });
}
