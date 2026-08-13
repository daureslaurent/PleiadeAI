import { toolConfigService } from '../../domain/tools/tool-config.service';
import { mediaWorkflowRepository } from '../../domain/media-workflows/media-workflow.repository';
import {
  bindingsOf,
  customBindings,
  customName,
  CUSTOM_PREFIX,
  type BindingKey,
  type MediaWorkflowDoc,
} from '../../domain/media-workflows/media-workflow.model';
import { META } from '../../domain/media-workflows/binding-meta';
import type { ComfyInputSpec } from '../../media/comfy/types';
import type { ToolConfigField } from '../types';

/**
 * Which `ToolConfigField.key` on each media tool's config governs which binding key(s) an agent may
 * override. Locking a config field (Tools page) removes every binding key it maps to from that
 * tool's agent-facing schema — `seed_mode` is the field the operator actually toggles to lock the
 * seed, since `seed` (the fixed-value field) only matters once `seed_mode` is "fixed".
 */
export const CONFIG_FIELD_BINDINGS: Record<string, Record<string, BindingKey[]>> = {
  generate_image: {
    size: ['width', 'height'],
    batch: ['batch'],
    negative_prompt: ['negative_prompt'],
    seed_mode: ['seed'],
  },
  generate_video: {
    size: ['width', 'height'],
    seconds: ['seconds'],
    fps: ['fps'],
    seed_mode: ['seed'],
  },
  generate_sound: {
    seconds: ['seconds'],
    negative_prompt: ['negative_prompt'],
    seed_mode: ['seed'],
  },
  edit_image: {
    negative_prompt: ['negative_prompt'],
    seed_mode: ['seed'],
  },
};

/** Sane bounds for a binding key when the workflow's own node schema didn't declare one. */
const FALLBACK_RANGE: Partial<Record<BindingKey, { min: number; max: number }>> = {
  seed: { min: 0, max: 2 ** 31 - 1 },
  seconds: { min: 1, max: 600 },
  fps: { min: 1, max: 120 },
  batch: { min: 1, max: 4 },
  width: { min: 64, max: 4096 },
  height: { min: 64, max: 4096 },
};

/** One JSON-schema property for a bound key, reusing `binding-meta.ts`'s label/description text. */
function propertyFor(key: BindingKey, spec?: ComfyInputSpec): Record<string, unknown> {
  const description = META[key].description;
  if (key === 'negative_prompt' || spec?.type === 'STRING') {
    return { type: 'string', description };
  }
  const fallback = FALLBACK_RANGE[key];
  const min = spec?.min ?? fallback?.min;
  const max = spec?.max ?? fallback?.max;
  return {
    type: spec?.type === 'FLOAT' ? 'number' : 'integer',
    description,
    ...(min !== undefined ? { minimum: min } : {}),
    ...(max !== undefined ? { maximum: max } : {}),
  };
}

/** The optional-argument properties a tool's currently-configured workflow actually supports. */
function overridableProperties(
  toolName: string,
  workflow: MediaWorkflowDoc | null,
  locked: Set<string>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  if (!workflow) return properties;
  const bindings = bindingsOf(workflow);
  const fieldMap = CONFIG_FIELD_BINDINGS[toolName] ?? {};
  for (const [configKey, bindingKeys] of Object.entries(fieldMap)) {
    if (locked.has(configKey)) continue;
    for (const key of bindingKeys) {
      const binding = bindings[key];
      if (!binding) continue;
      properties[key] = propertyFor(key, binding.spec);
    }
  }

  // Whatever this particular graph invents. `agent_editable` is the operator's decision, made per
  // parameter on the Media page: a category selector is exactly the sort of thing an agent should pick
  // (a request for a sound effect should not come back as a three-minute song), while a LoRA strength
  // usually is not.
  for (const [key, binding] of customBindings(bindings)) {
    if (!binding.agent_editable) continue;
    const numeric = binding.spec?.type === 'INT' || binding.spec?.type === 'FLOAT';
    properties[customName(key)] = {
      type: numeric ? (binding.spec?.type === 'FLOAT' ? 'number' : 'integer') : 'string',
      description: binding.description || `${binding.label || customName(key)} for this workflow.`,
      ...(binding.choices?.length ? { enum: [...binding.choices] } : {}),
      ...(binding.spec?.min !== undefined ? { minimum: binding.spec.min } : {}),
      ...(binding.spec?.max !== undefined ? { maximum: binding.spec.max } : {}),
    };
  }
  return properties;
}

/**
 * The custom-parameter half of a tool call's values.
 *
 * The agent addresses a custom parameter by its bare name (`category`), because that is what the
 * schema advertises; the binding map keys it as `custom:category`. Every other argument is mapped
 * too and simply ignored downstream — `applyBindings` writes nothing for a key the workflow doesn't
 * declare — which keeps this free of a per-tool list of "known" argument names to drift out of date.
 */
export function customArgValues(args: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(args)) {
    if (typeof value === 'string' || typeof value === 'number') out[`${CUSTOM_PREFIX}${name}`] = value;
  }
  return out;
}

/**
 * Build a media tool's agent-facing JSON schema: the tool's fixed base properties (`prompt`, and
 * `image` for `edit_image`) plus whatever optional params the currently-configured ComfyUI workflow
 * actually binds and the operator hasn't locked. Never throws — an unconfigured or unresolvable
 * workflow just falls back to the base shape, same as before this existed.
 */
export async function buildDynamicParams(
  toolName: string,
  configSchema: ToolConfigField[],
  base: { properties: Record<string, unknown>; required: string[] },
): Promise<Record<string, unknown>> {
  const { config, locked } = await toolConfigService.resolve(toolName, configSchema);
  const workflowId = String(config.workflow ?? '');
  const workflow = workflowId ? await mediaWorkflowRepository.findById(workflowId).catch(() => null) : null;
  const properties = overridableProperties(toolName, workflow, locked);
  return {
    type: 'object',
    properties: { ...base.properties, ...properties },
    required: base.required,
    additionalProperties: false,
  };
}
