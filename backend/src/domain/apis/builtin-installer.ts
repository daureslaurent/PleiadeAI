import { createLogger } from '../../config/logger';
import { SettingsModel } from '../settings/settings.model';
import { ApiSourceModel, DEFAULT_METHODS } from './api-source.model';
import { BUILTIN_APIS, type BuiltinApi } from './builtin-catalogue';

const log = createLogger('api-builtins');

/** The settings singleton's key (mirrors `settings.service.ts`). */
const SETTINGS_KEY = 'global';

/**
 * Installs shipped presets into `api_sources` as ordinary documents.
 *
 * A preset is a starting point, not a binding: once installed, the operator owns the document and
 * nothing re-reads the catalogue. So installing is deliberately *additive only* — an API whose name
 * already exists is skipped rather than reset, or an edited base URL would silently revert on the
 * next deploy. Deleting one and installing again is how you ask for the original back.
 */

/** Preset → document, dropping the `sample` calls (they exist for the catalogue's own smoke test). */
export function toDocument(preset: BuiltinApi): Record<string, unknown> {
  return {
    name: preset.name,
    description: preset.description,
    base_url: preset.base_url,
    enabled: preset.enabled ?? true,
    auth_type: preset.auth_type ?? 'none',
    auth_header: preset.auth_header ?? 'X-API-Key',
    auth_query: preset.auth_query ?? 'api_key',
    auth_username: '',
    token_url: preset.token_url ?? '',
    auth_scope: preset.auth_scope ?? '',
    auth_optional: preset.auth_optional ?? false,
    secret_hint: preset.secret_hint ?? '',
    headers: preset.headers ?? [],
    methods_allowed: preset.methods_allowed ?? [...DEFAULT_METHODS],
    timeout_ms: 30_000,
    notes: preset.notes ?? '',
    builtin: true,
    operations: preset.operations.map((op) => ({
      id: op.id,
      description: op.description,
      method: op.method ?? 'GET',
      path: op.path,
      base_url: op.base_url ?? '',
      query: op.query ?? [],
      body_template: op.body_template ?? '',
      params: (op.params ?? []).map((p) => ({
        name: p.name,
        in: p.in,
        type: p.type,
        required: p.required ?? false,
        description: p.description,
        default: p.default ?? '',
      })),
      enabled: true,
    })),
  };
}

/** Names already present in `api_sources`. */
async function existingNames(): Promise<Set<string>> {
  const docs = await ApiSourceModel.find({}, { name: 1 }).lean();
  return new Set(docs.map((d) => (d as { name: string }).name));
}

/**
 * Add presets this instance has never been offered.
 *
 * Called at boot, so a fresh deploy comes up with a working catalogue and a later release's new
 * presets arrive on their own. The settings singleton remembers what has been offered, which is what
 * keeps a preset the operator *deleted* from reappearing every restart — absence from `api_sources`
 * is not evidence that it was never installed.
 *
 * `force` (the settings page's button) ignores that memory and re-adds anything currently missing.
 */
export async function installBuiltins(force = false): Promise<string[]> {
  const existing = await existingNames();
  // Read the marker straight off the settings document: it is bookkeeping for this installer, not a
  // knob the operator sets, so it stays out of the operator-facing `EffectiveSettings` shape.
  const doc = await SettingsModel.findOne({ key: SETTINGS_KEY }, { api_builtins_installed: 1 }).lean();
  const alreadyOffered = ((doc?.api_builtins_installed as string[] | undefined) ?? []);
  const offered = new Set(force ? [] : alreadyOffered);

  const missing = BUILTIN_APIS.filter((preset) => !existing.has(preset.name) && !offered.has(preset.name));
  if (!missing.length) return [];

  await ApiSourceModel.insertMany(missing.map(toDocument));
  const names = missing.map((p) => p.name);
  await SettingsModel.updateOne(
    { key: SETTINGS_KEY },
    { $set: { key: SETTINGS_KEY, api_builtins_installed: [...new Set([...alreadyOffered, ...names])] } },
    { upsert: true },
  );
  log.info({ installed: names }, 'built-in APIs installed');
  return names;
}

/** Presets not currently configured — what the settings page offers to (re-)add. */
export async function missingBuiltins(): Promise<string[]> {
  const existing = await existingNames();
  return BUILTIN_APIS.filter((p) => !existing.has(p.name)).map((p) => p.name);
}
