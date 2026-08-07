import { toolConfigService } from '../../domain/tools/tool-config.service';
import { mediaWorkflowRepository } from '../../domain/media-workflows/media-workflow.repository';
import { bindingsOf, type BindingKey, type MediaWorkflowDoc } from '../../domain/media-workflows/media-workflow.model';
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
  return properties;
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
