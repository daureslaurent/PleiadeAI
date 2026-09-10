import { randomUUID } from 'node:crypto';
import { SettingsModel } from '../domain/settings/settings.model';
import { MODULES, moduleById, moduleDefaultEnabled } from './registry';
import { moduleStateFrom } from './state.service';
import { CUSTOM_MODULE_PREFIX, isCustomModuleId, type BlockPlacement, type CustomModule } from './types';

/**
 * The write side of the module system — everything `Settings → Modules` does.
 *
 * All of it lands on the settings singleton (`MODULES_PLAN.md` §5). Kept apart from
 * `state.service` because that one is on the hot path of every turn and must not import a model it
 * only writes.
 */

export class ModuleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The raw settings document, as a bag — only the module fields are read here. */
async function doc(): Promise<Record<string, unknown>> {
  return ((await SettingsModel.findOne({ key: 'global' }).lean()) ?? {}) as Record<string, unknown>;
}

/**
 * Switch a built-in module on or off.
 *
 * Two modules are special. A `mandatory` one is refused outright — without a clock the model dates
 * its own work wrongly and never notices. The **board** writes `forum_board_enabled` as well as its
 * own row: that flag is what `forum-scheduler.ts` reads to decide whether to dispatch at all, and a
 * module switch that left a scheduler running would be a switch that lies.
 */
export async function setModuleEnabled(id: string, enabled: boolean): Promise<void> {
  const mod = moduleById(id);
  if (!mod) throw new ModuleError(`unknown module '${id}'`, 404);
  if (mod.mandatory && !enabled) {
    throw new ModuleError(`'${mod.name}' cannot be switched off`, 409);
  }

  const current = await doc();
  const disabled = new Set(((current.modules_disabled as string[] | undefined) ?? []).filter(Boolean));
  if (enabled) disabled.delete(id);
  else disabled.add(id);

  const set: Record<string, unknown> = { modules_disabled: [...disabled] };
  if (id === 'board') set.forum_board_enabled = enabled;

  await SettingsModel.updateOne({ key: 'global' }, { $set: set }, { upsert: true });
}

/**
 * Replace (or clear) the operator's wording for one block. `null` reverts it to the code default —
 * which is why an override is stored rather than the rendered text being edited in place: a revert
 * has to be able to reach a wording the operator never saw.
 */
export async function setModuleOverrides(
  id: string,
  overrides: Record<string, string | null>,
): Promise<void> {
  const mod = moduleById(id);
  if (!mod) throw new ModuleError(`unknown module '${id}'`, 404);

  const current = await doc();
  const all = { ...((current.module_overrides as Record<string, Record<string, string>>) ?? {}) };
  const mine = { ...(all[id] ?? {}) };

  for (const [title, text] of Object.entries(overrides)) {
    const block = mod.blocks?.find((b) => b.title === title);
    if (!block) throw new ModuleError(`'${mod.name}' has no block called '${title}'`);
    if (!block.overridable) {
      throw new ModuleError(`'${title}' renders live data — there is nothing to override`);
    }
    if (text === null || !text.trim()) delete mine[title];
    else mine[title] = text;
  }

  if (Object.keys(mine).length) all[id] = mine;
  else delete all[id];

  await SettingsModel.updateOne({ key: 'global' }, { $set: { module_overrides: all } }, { upsert: true });
}

const PLACEMENTS: BlockPlacement[] = ['system_head', 'system_tail', 'system_suffix', 'user_suffix'];

/** Validate and normalise a custom module coming off the wire. */
function sanitise(input: Partial<CustomModule>, id: string): CustomModule {
  const name = String(input.name ?? '').trim();
  if (!name) throw new ModuleError('a module needs a name');
  const text = String(input.text ?? '').trim();
  if (!text) throw new ModuleError('a module with no text contributes nothing');
  const placement = PLACEMENTS.includes(input.placement as BlockPlacement)
    ? (input.placement as BlockPlacement)
    : 'system_tail';
  const order = Number.isFinite(Number(input.order)) ? Number(input.order) : 500;
  return {
    id,
    name,
    description: String(input.description ?? '').trim(),
    text,
    placement,
    order,
    enabled: input.enabled !== false,
  };
}

/**
 * Create or update an operator-authored module. The id is minted here with the `custom:` prefix and
 * never taken from the client on create — that prefix is the guard that keeps a request from
 * smuggling a fake built-in into the list, the same way `builtin:` guards the mode list.
 */
export async function upsertCustomModule(input: Partial<CustomModule>): Promise<CustomModule> {
  const current = await doc();
  const list = [...(((current.modules_custom as CustomModule[] | undefined) ?? []) as CustomModule[])];

  const id = input.id ? String(input.id) : `${CUSTOM_MODULE_PREFIX}${randomUUID().slice(0, 8)}`;
  if (!isCustomModuleId(id)) throw new ModuleError('a custom module id must start with `custom:`');

  const next = sanitise(input, id);
  const at = list.findIndex((m) => m.id === id);
  if (at === -1) list.push(next);
  else list[at] = next;

  await SettingsModel.updateOne({ key: 'global' }, { $set: { modules_custom: list } }, { upsert: true });
  return next;
}

export async function deleteCustomModule(id: string): Promise<void> {
  if (!isCustomModuleId(id)) throw new ModuleError('only operator-authored modules can be deleted', 409);
  const current = await doc();
  const list = (((current.modules_custom as CustomModule[] | undefined) ?? []) as CustomModule[]).filter(
    (m) => m.id !== id,
  );
  await SettingsModel.updateOne({ key: 'global' }, { $set: { modules_custom: list } }, { upsert: true });
}

/** Everything the settings page renders, built-ins and custom alike. */
export async function listModules() {
  const settings = await doc();
  const state = moduleStateFrom(settings as Record<string, unknown>);
  return {
    modules: MODULES.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      group: m.group,
      mandatory: m.mandatory === true,
      defaultEnabled: moduleDefaultEnabled(m),
      enabled: state.enabled(m.id),
      tools: m.tools ?? [],
      settingsKeys: m.settingsKeys ?? [],
      blocks: (m.blocks ?? []).map((b) => ({
        title: b.title,
        placement: b.placement,
        order: b.order,
        overridable: b.overridable === true,
        override: state.override(m.id, b.title) ?? null,
      })),
    })),
    custom: state.custom,
  };
}
