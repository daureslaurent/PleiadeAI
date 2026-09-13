import { settingsService } from '../domain/settings/settings.service';
import { MODULES, moduleById, moduleDefaultEnabled, moduleSubagentDefault } from './registry';
import {
  CUSTOM_MODULE_PREFIX,
  isCustomModuleId,
  type BlockPlacement,
  type CustomModule,
  type ModuleScope,
  type PromptModule,
} from './types';

/**
 * Which modules are on, what the operator has rewritten, and what they have written themselves.
 *
 * Enablement is stored as a list of ids *overridden away from their default* rather than a row per
 * module — the same shape `global_modes_disabled` uses, and for the same reason: the modules
 * themselves are code-defined, so a release that adds one has it on by default instead of missing
 * from a table nobody migrated. Almost every module defaults on, so in practice this list reads as
 * "disabled" — but the one module that ships off (`board`) needs the same list to mean "enabled" for
 * its id, which is why membership is interpreted relative to `moduleDefaultEnabled`, never as a
 * literal "off".
 */
export interface ModuleState {
  /** Ids whose enabled state the operator flipped away from `moduleDefaultEnabled`. */
  disabled: Set<string>;
  /** Ids whose subagent-profile state the operator flipped away from `moduleSubagentDefault`. */
  subagentFlipped: Set<string>;
  /** `{ [moduleId]: { [blockTitle]: text } }` — a rewritten block's replacement wording. */
  overrides: Record<string, Record<string, string>>;
  custom: CustomModule[];
  /**
   * Whether a built-in module is live. Mandatory modules are always true. In `subagent` scope a module
   * must be on *and* left in the subagent profile — the profile narrows, it never re-enables.
   */
  enabled(id: string, scope?: ModuleScope): boolean;
  /** The profile half alone: whether this module applies to subagent runs when it is on. */
  inSubagentProfile(id: string): boolean;
  /** The operator's replacement wording for one block, if they wrote one. */
  override(moduleId: string, blockTitle: string): string | undefined;
  /** Enabled operator-authored modules at one placement, already ordered. */
  customAt(placement: BlockPlacement, scope?: ModuleScope): CustomModule[];
}

type SettingsShape = {
  modules_disabled?: unknown;
  modules_disabled_subagent?: unknown;
  module_overrides?: unknown;
  modules_custom?: unknown;
};

/** Build the state from an already-fetched settings document — `AgentRunner` reads it once a turn. */
export function moduleStateFrom(settings: SettingsShape): ModuleState {
  const disabled = new Set(
    (Array.isArray(settings.modules_disabled) ? settings.modules_disabled : []).filter(
      (id): id is string => typeof id === 'string',
    ),
  );
  const subagentFlipped = new Set(
    (Array.isArray(settings.modules_disabled_subagent) ? settings.modules_disabled_subagent : []).filter(
      (id): id is string => typeof id === 'string',
    ),
  );
  const overrides = (settings.module_overrides ?? {}) as Record<string, Record<string, string>>;
  const custom = (Array.isArray(settings.modules_custom) ? settings.modules_custom : [])
    .filter((m): m is CustomModule => !!m && typeof (m as CustomModule).id === 'string')
    .map((m) => ({ ...m }));

  const inProfile = (id: string): boolean => {
    // Custom modules carry no default of their own, so they follow the profile like any other row.
    const mod = moduleById(id);
    if (mod?.mandatory) return true;
    const def = mod ? moduleSubagentDefault(mod) : true;
    return subagentFlipped.has(id) ? !def : def;
  };

  return {
    disabled,
    subagentFlipped,
    overrides,
    custom,
    enabled(id: string, scope: ModuleScope = 'turn') {
      const mod = moduleById(id);
      // An id no build knows about is not enabled — a stale disabled entry must never resurrect a
      // module that was removed, and a typo must never gate a tool nobody owns.
      if (!mod) return false;
      if (mod.mandatory) return true;
      const def = moduleDefaultEnabled(mod);
      // Presence in the list means "flipped away from default", not "off" — a module that ships off
      // (`board`) is turned ON by being in this same list, exactly the way one that ships on is
      // turned off by it.
      const on = disabled.has(id) ? !def : def;
      return scope === 'subagent' ? on && inProfile(id) : on;
    },
    inSubagentProfile: inProfile,
    override(moduleId: string, blockTitle: string) {
      const text = overrides?.[moduleId]?.[blockTitle];
      return typeof text === 'string' && text.trim() ? text : undefined;
    },
    customAt(placement: BlockPlacement, scope: ModuleScope = 'turn') {
      return custom
        .filter(
          (m) =>
            m.enabled &&
            m.placement === placement &&
            m.text.trim() &&
            (scope === 'turn' || inProfile(m.id)),
        )
        .sort((a, b) => a.order - b.order);
    },
  };
}

/** Fetch the settings document and resolve the state from it. */
export async function resolveModuleState(): Promise<ModuleState> {
  return moduleStateFrom((await settingsService.get()) as unknown as SettingsShape);
}

/**
 * Effective enablement for one *tool*, module gate included: `moduleEnabled(owner) && toolConfig`.
 * A tool no module claims is never gated here (see `toolOwner`).
 */
export function toolAllowedByModules(state: ModuleState, toolName: string, scope: ModuleScope = 'turn'): boolean {
  // Imported lazily-by-value to keep this module free of a cycle with `tools/registry`.
  const owner = MODULES.find((m) => (m.tools ?? []).includes(toolName));
  return owner ? state.enabled(owner.id, scope) : true;
}

/**
 * Names of the core tools currently unreachable because their module is off — or, in `subagent`
 * scope, because the subagent profile leaves their module out: one switch removes the blocks and the
 * tools they describe, in a child run exactly as in an ordinary one.
 */
export function toolsDisabledByModules(state: ModuleState, scope: ModuleScope = 'turn'): Set<string> {
  const out = new Set<string>();
  for (const m of MODULES) {
    if (!m.tools?.length || state.enabled(m.id, scope)) continue;
    for (const t of m.tools) out.add(t);
  }
  return out;
}

export { CUSTOM_MODULE_PREFIX, isCustomModuleId };
