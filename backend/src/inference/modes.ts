import {
  asEndpointModes,
  modesForModel,
  type Endpoint,
  type EndpointMode,
  type GlobalMode,
  type ModeSampler,
} from '../domain/endpoints/endpoint.model';

/**
 * Per-model inference modes (`MODES_PLAN.md`): the rules for turning the operator's picks into an
 * actual sampling override + prompt suffixes. Kept in one module so the resolver, the runner and the
 * route that feeds the composer all agree on what "this mode applies" means.
 */

/** The sampling overrides a mode stack produces. `null`/absent means "don't send this field". */
export interface ModeSampling {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
}

/** Operator text a mode stack appends to the turn, in the operator's own order. */
export interface ModePrompts {
  system: string[];
  user: string[];
}

/** Maps a stored sampler name onto the camelCase field the inference layer carries it in. */
const SAMPLER_FIELD: Record<ModeSampler, keyof ModeSampling> = {
  temperature: 'temperature',
  top_p: 'topP',
  top_k: 'topK',
  min_p: 'minP',
  presence_penalty: 'presencePenalty',
  repetition_penalty: 'repetitionPenalty',
};

/**
 * The modes that actually apply to this turn: enabled, attached to the *resolved* model (or global,
 * which every model gets), and picked by the operator — in the endpoint's array order, which is the order overlapping sampling fields
 * resolve in. An id that no longer resolves (the mode was deleted, or the agent moved to another
 * model) is silently dropped: a stale selection must never break the conversation that made it.
 */
export function selectModes(
  endpoint: Pick<Endpoint, 'modes'> | null,
  model: string,
  ids: readonly string[] | undefined,
  globals?: GlobalMode[],
): EndpointMode[] {
  if (!ids?.length) return [];
  const wanted = new Set(ids);
  return offeredModes(endpoint, model, globals).filter((m) => wanted.has(m.id));
}

/**
 * Every mode on offer for a turn on `model`: the endpoint's own per-model ones first, then the
 * fleet-wide globals. One list, so a caller applies a single stack and never branches on where a
 * mode came from; globals come last so a model-specific sampling preset can't be undone by one.
 */
export function offeredModes(
  endpoint: Pick<Endpoint, 'modes'> | null,
  model: string,
  globals?: GlobalMode[],
): EndpointMode[] {
  return [...modesForModel(endpoint, model), ...asEndpointModes(globals)];
}

/**
 * Fold every `sampling` mode's set fields into one override, last mode wins per field. Only fields
 * the operator actually typed a number for are carried: an unset sampler stays absent so the global
 * setting (temperature/top_p) or llama.cpp's own default (top_k/min_p/penalties) still stands.
 */
export function modeSampling(modes: readonly EndpointMode[]): ModeSampling {
  const out: ModeSampling = {};
  for (const mode of modes) {
    if (mode.type !== 'sampling') continue;
    for (const [sampler, field] of Object.entries(SAMPLER_FIELD) as [ModeSampler, keyof ModeSampling][]) {
      const raw = mode.params?.[sampler];
      if (typeof raw === 'number' && Number.isFinite(raw)) out[field] = raw;
    }
  }
  return out;
}

/**
 * The text every `prompt` mode contributes, split by placement. `user_suffix` exists because
 * llama.cpp chat-template control tokens (`/no_think`, `/think`) are only honoured on the user turn;
 * `system_suffix` is for standing style directives, which belong with the rest of the prompt.
 */
export function modePrompts(modes: readonly EndpointMode[]): ModePrompts {
  const prompts: ModePrompts = { system: [], user: [] };
  for (const mode of modes) {
    if (mode.type !== 'prompt') continue;
    const text = (mode.text ?? '').trim();
    if (!text) continue;
    prompts[mode.placement === 'user_suffix' ? 'user' : 'system'].push(text);
  }
  return prompts;
}
