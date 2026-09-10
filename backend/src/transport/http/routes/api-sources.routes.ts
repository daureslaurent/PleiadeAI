import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { apiSourceRepository } from '../../../domain/apis/api-source.repository';
import {
  AUTH_TYPES,
  DEFAULT_METHODS,
  HTTP_METHODS,
  type ApiSourceDoc,
} from '../../../domain/apis/api-source.model';
import { ApiCallError, callOperation } from '../../../domain/apis/api-caller.service';
import { BUILTIN_APIS } from '../../../domain/apis/builtin-catalogue';
import { installBuiltins, missingBuiltins } from '../../../domain/apis/builtin-installer';
import { encryptSecret } from '../../../isolation/ssh.service';

const log = createLogger('api-sources-routes');

/**
 * Configured HTTP APIs (Settings → APIs; `API_TOOL_PLAN.md`).
 *
 * The credential is write-only across this surface: `secret_enc` is `select: false` so it is absent
 * from reads anyway, and the public projection reports only `has_secret`. A PUT that omits `secret`
 * leaves the stored one alone, so editing a base URL can never blank a key — the `monitor_targets`
 * idiom.
 */
export const apiSourcesRouter = Router();

/** Strip the credential and report only whether one is stored. */
function publicView(doc: ApiSourceDoc) {
  const { secret_enc, ...rest } = doc.toJSON() as Record<string, unknown>;
  void secret_enc;
  return { ...rest, has_secret: Boolean(doc.secret_enc) };
}

/** Keep only the fields a client may write, coercing each to what the schema expects. */
function sanitize(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const str = (k: string) => {
    if (typeof body[k] === 'string') patch[k] = (body[k] as string).trim();
  };
  str('name');
  str('description');
  str('base_url');
  str('auth_header');
  str('auth_query');
  str('auth_username');
  str('token_url');
  str('auth_scope');
  str('secret_hint');
  str('notes');
  if (typeof patch.name === 'string') patch.name = (patch.name as string).toLowerCase();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.auth_optional === 'boolean') patch.auth_optional = body.auth_optional;
  if (typeof body.auth_type === 'string' && (AUTH_TYPES as readonly string[]).includes(body.auth_type)) {
    patch.auth_type = body.auth_type;
  }
  if (Number.isFinite(Number(body.timeout_ms))) patch.timeout_ms = Math.max(1000, Number(body.timeout_ms));
  if (Array.isArray(body.methods_allowed)) {
    patch.methods_allowed = body.methods_allowed.filter((m): m is string =>
      typeof m === 'string' && (HTTP_METHODS as readonly string[]).includes(m),
    );
  }
  if (Array.isArray(body.headers)) patch.headers = body.headers;
  if (Array.isArray(body.operations)) patch.operations = body.operations;
  return patch;
}

/**
 * Fold a submitted credential into the patch. An absent `secret` key means "leave it"; an explicit
 * empty string means "clear it" — the settings form only sends the field when the operator typed
 * into it, so the distinction is what makes save-on-blur safe.
 */
function secretPatch(body: Record<string, unknown>): Record<string, unknown> {
  if (!('secret' in body)) return {};
  const raw = typeof body.secret === 'string' ? body.secret : '';
  return { secret_enc: raw ? encryptSecret(raw) : null };
}

apiSourcesRouter.get('/', async (_req, res) => {
  const docs = await apiSourceRepository.list();
  res.json(docs.map(publicView));
});

apiSourcesRouter.post('/', async (req, res) => {
  const patch = { ...sanitize(req.body ?? {}), ...secretPatch(req.body ?? {}) };
  if (!patch.name || !patch.base_url) {
    res.status(400).json({ error: 'name and base_url are required' });
    return;
  }
  if (!/^[a-z0-9_]+$/.test(String(patch.name))) {
    res.status(400).json({ error: 'name must be lowercase letters, digits or underscores — it is the namespace in `name.operation`' });
    return;
  }
  if (await apiSourceRepository.findByName(String(patch.name))) {
    res.status(409).json({ error: `an API named "${patch.name}" already exists` });
    return;
  }
  if (!patch.methods_allowed) patch.methods_allowed = [...DEFAULT_METHODS];

  const doc = await apiSourceRepository.create(patch);
  log.info({ name: doc.name }, 'api source created');
  res.status(201).json(publicView(doc));
});

apiSourcesRouter.put('/:id', async (req, res) => {
  const patch = { ...sanitize(req.body ?? {}), ...secretPatch(req.body ?? {}) };
  if (patch.name && !/^[a-z0-9_]+$/.test(String(patch.name))) {
    res.status(400).json({ error: 'name must be lowercase letters, digits or underscores' });
    return;
  }
  const doc = await apiSourceRepository.update(req.params.id, patch);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(publicView(doc));
});

apiSourcesRouter.delete('/:id', async (req, res) => {
  const doc = await apiSourceRepository.delete(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

/**
 * Run one operation against the live service, exactly as an agent would — same builder, same auth,
 * same JSON parsing — so a green Test means the agent's call will work rather than merely that the
 * host answers a ping.
 */
apiSourcesRouter.post('/:id/test', async (req, res) => {
  const doc = await apiSourceRepository.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const operationId = String(req.body?.operation ?? '');
  const params = (req.body?.params ?? {}) as Record<string, unknown>;

  try {
    const outcome = await callOperation(
      operationId.includes('.') ? operationId : `${doc.name}.${operationId}`,
      params,
      { maxResponseTokens: 1200, via: 'test' },
    );
    res.json({
      ok: true,
      status: outcome.status,
      url: outcome.url,
      duration_ms: outcome.duration_ms,
      truncated: outcome.truncated,
      data: outcome.data,
    });
  } catch (err) {
    if (err instanceof ApiCallError) {
      res.json({ ok: false, status: err.status, error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * The shipped catalogue (`builtin-catalogue.ts`) and which of its presets are not currently
 * configured — so the settings page can offer to add back one the operator deleted, or the presets a
 * newer release introduced.
 */
apiSourcesRouter.get('/builtins', async (_req, res) => {
  const missing = new Set(await missingBuiltins());
  res.json(
    BUILTIN_APIS.map((preset) => ({
      name: preset.name,
      description: preset.description,
      operations: preset.operations.length,
      needs_setup: Boolean(preset.auth_type && preset.auth_type !== 'none' && !preset.auth_optional),
      installed: !missing.has(preset.name),
    })),
  );
});

/** Install every preset not currently configured, ignoring the "already offered" marker. */
apiSourcesRouter.post('/builtins/install', async (_req, res) => {
  const installed = await installBuiltins(true);
  log.info({ installed }, 'built-in APIs installed from settings');
  res.json({ installed });
});
