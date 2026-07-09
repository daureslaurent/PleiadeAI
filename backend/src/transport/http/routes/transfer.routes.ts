import { Router } from 'express';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { isolationRepository } from '../../../domain/isolations/isolation.repository';
import { endpointRepository } from '../../../domain/endpoints/endpoint.repository';
import { qdrantService } from '../../../domain/memory/qdrant.service';
import { cloneService, CLONE_TYPE, DEFAULT_LOG_LIMIT } from '../../../domain/transfer/clone.service';
import type { AgentDoc } from '../../../domain/agents/agent.model';
import type { IsolationDoc } from '../../../domain/isolations/isolation.model';
import { createLogger } from '../../../config/logger';

const log = createLogger('transfer-routes');

/**
 * Portable export/import of fleet configuration (Settings → Backup & Transfer).
 *
 * Two artifacts, deliberately separate (Qdrant vectors are bulky and *not* re-importable):
 *   • config  — agents + their referenced isolations, importable onto another instance.
 *   • memory  — a per-namespace Qdrant vector dump, for archival only.
 *
 * Secrets never leave: isolation SSH private keys are dropped, and agent `parameters` whose key
 * looks secret (token/key/password/…) are blanked to '' so the operator re-enters them on import.
 * Cross-instance references (isolation, endpoint) are carried *by name*, since ObjectIds don't
 * survive a move to another database.
 */
export const transferRouter = Router();

const CONFIG_TYPE = 'pleiades-config';
const MEMORY_TYPE = 'pleiades-memory';
const FORMAT_VERSION = 1;

/** Heuristic: does a parameter key name a secret whose value must not be exported? */
const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|access[_-]?key|private|credential|auth)/i;

function sanitizeParameters(parameters: Map<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of parameters ?? new Map<string, string>()) {
    out[k] = SECRET_KEY.test(k) ? '' : v;
  }
  return out;
}

interface ExportedIsolation {
  name: string;
  description: string;
  dockerfile: string;
  cpus: string;
  memory: string;
  network: string;
  idle_timeout_ms: number;
  ssh_public_key: string;
  ssh_known_hosts: string;
  // Note: VPN config is intentionally omitted — the WireGuard `.conf` is select:false and secret
  // (it contains the private key), so it never travels. The operator re-uploads it on the target.
}

function serializeIsolation(iso: IsolationDoc): ExportedIsolation {
  // Note: ssh_private_key_enc is `select:false` and never fetched here; build state is machine-local.
  return {
    name: iso.name,
    description: iso.description ?? '',
    dockerfile: iso.dockerfile ?? '',
    cpus: iso.cpus ?? '1',
    memory: iso.memory ?? '1g',
    network: iso.network ?? 'host',
    idle_timeout_ms: iso.idle_timeout_ms ?? 1_800_000,
    ssh_public_key: iso.ssh_public_key ?? '',
    ssh_known_hosts: iso.ssh_known_hosts ?? '',
  };
}

/** Resolve the caller's agent selection: explicit ids, or all agents when `all` is set. */
async function selectAgents(body: { agentIds?: string[]; all?: boolean }): Promise<AgentDoc[]> {
  if (body.all) return agentRepository.list();
  const ids = Array.isArray(body.agentIds) ? body.agentIds : [];
  const found = await Promise.all(ids.map((id) => agentRepository.findById(id)));
  return found.filter((a): a is AgentDoc => Boolean(a));
}

/**
 * Same selection, from a query string, for the GET twins of the export routes.
 * `?all=true` or `?agentIds=a,b,c`. The GET forms exist so a **read-only API key** can drive an
 * export (keys are refused on any non-GET method — see `middleware/auth.ts`).
 */
function selectAgentsFromQuery(query: Record<string, unknown>): Promise<AgentDoc[]> {
  const all = query.all === 'true' || query.all === '1';
  const raw = typeof query.agentIds === 'string' ? query.agentIds : '';
  const agentIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return selectAgents({ all, agentIds });
}

/**
 * Export the config bundle for the selected agents. Referenced isolations and endpoints are
 * resolved and inlined (isolations fully, endpoints by name only — endpoints often hold API keys
 * and aren't part of this feature's scope).
 */
async function buildConfigBundle(agents: AgentDoc[]) {
  // Gather the distinct isolations these agents reference so import can recreate + relink them.
  const isoIds = [...new Set(agents.map((a) => a.isolation_id).filter(Boolean).map(String))];
  const isolationDocs = (await Promise.all(isoIds.map((id) => isolationRepository.findById(id)))).filter(
    (i): i is IsolationDoc => Boolean(i),
  );
  const isoNameById = new Map(isolationDocs.map((i) => [String(i._id), i.name]));

  // Endpoints carried by name only (so a moved agent can relink to a same-named endpoint).
  const endpoints = await endpointRepository.list();
  const endpointNameById = new Map(endpoints.map((e) => [String(e._id), e.name]));

  return {
    type: CONFIG_TYPE,
    version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    isolations: isolationDocs.map(serializeIsolation),
    agents: agents.map((a) => ({
      name: a.name,
      description: a.description ?? '',
      subagent: a.subagent ?? true,
      system_prompt: a.system_prompt,
      tools_allowed: a.tools_allowed ?? [],
      qdrant_namespace: a.qdrant_namespace,
      parameters: sanitizeParameters(a.parameters as unknown as Map<string, string>),
      agents_md: a.agents_md ?? '',
      isolation_name: a.isolation_id ? isoNameById.get(String(a.isolation_id)) ?? null : null,
      isolation_volume_mode: a.isolation_volume_mode ?? 'individual',
      endpoint_name: a.endpoint_id ? endpointNameById.get(String(a.endpoint_id)) ?? null : null,
      model: a.model ?? '',
      color: a.color ?? null,
      icon: a.icon ?? '',
    })),
  };
}

async function buildMemoryBundle(agents: AgentDoc[]) {
  const namespaces = [];
  for (const a of agents) {
    const dump = await qdrantService.exportNamespace(a.qdrant_namespace);
    namespaces.push({
      agent_name: a.name,
      namespace: a.qdrant_namespace,
      vector_size: dump.vector_size,
      points: dump.points,
    });
  }
  return { type: MEMORY_TYPE, version: FORMAT_VERSION, exported_at: new Date().toISOString(), namespaces };
}

function sendDownload(res: Parameters<Parameters<typeof transferRouter.get>[1]>[1], name: string, bundle: unknown, pretty = false) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="pleiades-${name}-${Date.now()}.json"`);
  res.send(JSON.stringify(bundle, null, pretty ? 2 : undefined));
}

transferRouter.post('/export/config', async (req, res) => {
  sendDownload(res, 'config', await buildConfigBundle(await selectAgents(req.body ?? {})), true);
});

/** Export a Qdrant memory dump (vectors + payloads) for the selected agents' namespaces. */
transferRouter.post('/export/memory', async (req, res) => {
  sendDownload(res, 'memory', await buildMemoryBundle(await selectAgents(req.body ?? {})));
});

// --- GET twins of the exports, so a read-only API key can drive a backup (see middleware/auth.ts).
// `?all=true` or `?agentIds=a,b`. Note that a key-authenticated response is additionally passed
// through `redact.ts`, which blanks any property whose *name* looks like a secret.

transferRouter.get('/export/config', async (req, res) => {
  sendDownload(res, 'config', await buildConfigBundle(await selectAgentsFromQuery(req.query)), true);
});

transferRouter.get('/export/memory', async (req, res) => {
  sendDownload(res, 'memory', await buildMemoryBundle(await selectAgentsFromQuery(req.query)));
});

/**
 * Full-fidelity mirror of this instance (agents, isolations, sessions, messages, scores, inference
 * logs) with `_id`s preserved. Feeds `POST /import/clone` on a *different* instance. `?logs=N` caps
 * the inference-log archive (default 200 — the archive is unbounded).
 */
transferRouter.get('/export/clone', async (req, res) => {
  const raw = Number(req.query.logs);
  const logLimit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), 10_000) : DEFAULT_LOG_LIMIT;
  sendDownload(res, 'clone', await cloneService.exportClone(logLimit));
});

/**
 * **Destructive.** Replaces this instance's agents, isolations, sessions, messages, scores and
 * inference logs with the bundle's. Requires `{ confirm: 'REPLACE' }` in the body so it can never be
 * triggered by an accidental POST. API keys can't reach this at all (they're GET-only).
 */
transferRouter.post('/import/clone', async (req, res) => {
  const bundle = req.body ?? {};
  if (bundle.confirm !== 'REPLACE') {
    res.status(400).json({ error: "refusing to wipe: pass { confirm: 'REPLACE' }" });
    return;
  }
  if (bundle.type !== CLONE_TYPE) {
    res.status(400).json({ error: `not a ${CLONE_TYPE} file` });
    return;
  }
  try {
    const summary = await cloneService.importClone(bundle);
    res.json({ ok: true, ...summary });
  } catch (err) {
    log.error({ err }, 'clone import failed');
    res.status(500).json({ error: 'clone import failed', detail: (err as Error).message });
  }
});

/**
 * Import a config bundle. Name collisions **overwrite** the existing record (chosen policy).
 * Isolations are upserted first so agents can relink to them by name; a newly created isolation
 * has no SSH private key (secrets are never transferred) — add one via the Isolations page if the
 * agent needs outbound SSH. Endpoints are relinked by name when a same-named endpoint exists,
 * otherwise left null (→ fleet default).
 */
transferRouter.post('/import/config', async (req, res) => {
  const bundle = req.body ?? {};
  if (bundle.type !== CONFIG_TYPE) {
    res.status(400).json({ error: `not a ${CONFIG_TYPE} file` });
    return;
  }

  const summary = {
    isolations: { created: 0, overwritten: 0 },
    agents: { created: 0, overwritten: 0 },
    warnings: [] as string[],
  };

  // 1) Isolations first — build a name→id map for agent relinking.
  const isoIdByName = new Map<string, string>();
  for (const inc of (bundle.isolations ?? []) as ExportedIsolation[]) {
    if (!inc?.name) continue;
    const patch = {
      description: inc.description ?? '',
      dockerfile: inc.dockerfile ?? '',
      cpus: inc.cpus ?? '1',
      memory: inc.memory ?? '1g',
      network: inc.network ?? 'host',
      idle_timeout_ms: inc.idle_timeout_ms ?? 1_800_000,
      ssh_public_key: inc.ssh_public_key ?? '',
      ssh_known_hosts: inc.ssh_known_hosts ?? '',
    };
    const existing = await isolationRepository.list().then((l) => l.find((i) => i.name === inc.name));
    if (existing) {
      // Overwrite non-secret fields; leave the existing SSH private key + build state intact.
      const updated = await isolationRepository.update(String(existing._id), patch);
      isoIdByName.set(inc.name, String((updated ?? existing)._id));
      summary.isolations.overwritten++;
    } else {
      const created = await isolationRepository.create({ name: inc.name, ...patch });
      isoIdByName.set(inc.name, String(created._id));
      summary.isolations.created++;
    }
  }

  // Endpoint name→id map for optional relinking.
  const endpoints = await endpointRepository.list();
  const endpointIdByName = new Map(endpoints.map((e) => [e.name, String(e._id)]));

  // 2) Agents — overwrite by name, relinking isolation/endpoint by name.
  for (const inc of (bundle.agents ?? []) as Array<Record<string, unknown>>) {
    const name = String(inc.name ?? '').trim();
    if (!name || typeof inc.system_prompt !== 'string' || typeof inc.qdrant_namespace !== 'string') {
      summary.warnings.push(`skipped an agent with missing name/system_prompt/namespace`);
      continue;
    }

    const isoName = inc.isolation_name as string | null;
    let isolation_id: string | null = null;
    if (isoName) {
      isolation_id = isoIdByName.get(isoName) ?? null;
      if (!isolation_id) summary.warnings.push(`agent "${name}": isolation "${isoName}" not found — left unassigned`);
    }
    const epName = inc.endpoint_name as string | null;
    let endpoint_id: string | null = null;
    if (epName) {
      endpoint_id = endpointIdByName.get(epName) ?? null;
      if (!endpoint_id) summary.warnings.push(`agent "${name}": endpoint "${epName}" not found — using fleet default`);
    }

    const fields = {
      description: String(inc.description ?? ''),
      subagent: inc.subagent === undefined ? true : Boolean(inc.subagent),
      system_prompt: inc.system_prompt,
      tools_allowed: Array.isArray(inc.tools_allowed) ? (inc.tools_allowed as string[]) : [],
      agents_md: String(inc.agents_md ?? ''),
      isolation_id,
      isolation_volume_mode: inc.isolation_volume_mode === 'shared' ? 'shared' : 'individual',
      endpoint_id,
      model: String(inc.model ?? ''),
      color: typeof inc.color === 'number' ? inc.color : null,
      icon: String(inc.icon ?? ''),
    } as const;
    const parameters = (inc.parameters ?? {}) as Record<string, string>;

    const existing = await agentRepository.findByName(name);
    if (existing) {
      // Cast: isolation_id/endpoint_id are strings here; Mongoose casts them to ObjectId on $set.
      await agentRepository.update(String(existing._id), fields as never);
      // Re-apply parameters individually (map merge; existing keys not in the import are kept).
      for (const [k, v] of Object.entries(parameters)) {
        await agentRepository.setParameter(String(existing._id), k, v);
      }
      summary.agents.overwritten++;
    } else {
      // A fresh agent needs a unique qdrant_namespace; reuse the exported one, or derive from name
      // if it would collide with an existing (different) agent's namespace.
      let namespace = inc.qdrant_namespace;
      const nsOwner = await agentRepository.list().then((l) => l.find((a) => a.qdrant_namespace === namespace));
      if (nsOwner) namespace = `agent_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now()}`;
      const created = await agentRepository.create({
        name,
        description: fields.description,
        subagent: fields.subagent,
        system_prompt: fields.system_prompt,
        tools_allowed: fields.tools_allowed,
        qdrant_namespace: namespace,
        parameters,
        endpoint_id: fields.endpoint_id,
        model: fields.model,
        color: fields.color,
        icon: fields.icon,
      });
      // create() doesn't cover isolation/agents_md/volume mode — patch them in.
      await agentRepository.update(String(created._id), {
        agents_md: fields.agents_md,
        isolation_id: fields.isolation_id,
        isolation_volume_mode: fields.isolation_volume_mode,
      } as never);
      summary.agents.created++;
    }
  }

  log.info(summary, 'config import complete');
  res.json({ ok: true, ...summary });
});
