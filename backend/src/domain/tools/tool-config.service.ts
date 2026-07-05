import { ToolConfigModel } from './tool-config.model';
import type { ToolConfigField } from '../../tools/types';

export interface ResolvedToolConfig {
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}

/** Coerce a stored/raw value to the type its field declares (Mongo Mixed is untyped). */
function coerce(field: ToolConfigField, value: unknown): string | number | boolean {
  if (value === undefined || value === null) return field.default;
  switch (field.type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : Number(field.default);
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 'true';
    default:
      return String(value);
  }
}

/**
 * Persists and resolves per-tool operator config. Reads always layer the stored document over the
 * tool's declared schema defaults, so a tool sees a complete, correctly-typed config object even
 * before it has ever been saved.
 */
export const toolConfigService = {
  /** Effective config for one tool, defaults filled in and values coerced to their declared types. */
  async resolve(name: string, schema: ToolConfigField[]): Promise<ResolvedToolConfig> {
    const doc = await ToolConfigModel.findOne({ name }).lean();
    const stored = (doc?.config ?? {}) as Record<string, unknown>;
    const config: Record<string, string | number | boolean> = {};
    for (const field of schema) {
      config[field.key] = coerce(field, stored[field.key]);
    }
    return { enabled: doc?.enabled ?? true, config };
  },

  /** Names of tools the operator has explicitly disabled (used to filter an agent's toolset). */
  async disabledNames(): Promise<Set<string>> {
    const docs = await ToolConfigModel.find({ enabled: false }, { name: 1 }).lean();
    return new Set(docs.map((d) => d.name));
  },

  /** Upsert the enable flag and/or option values for a tool. */
  async update(
    name: string,
    patch: { enabled?: boolean; config?: Record<string, unknown> },
  ): Promise<void> {
    const set: Record<string, unknown> = { name };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.config !== undefined) {
      for (const [k, v] of Object.entries(patch.config)) set[`config.${k}`] = v;
    }
    await ToolConfigModel.updateOne({ name }, { $set: set }, { upsert: true });
  },
};
