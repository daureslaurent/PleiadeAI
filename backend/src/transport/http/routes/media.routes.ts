import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { comfyClient } from '../../../media/comfy/ComfyHttpClient';
import { ComfyError } from '../../../media/comfy/errors';
import {
  autoBind,
  describeNodes,
  loadSchemas,
  relevantKeys,
  structureHash,
  validateWorkflow,
} from '../../../media/comfy/graph-introspect';
import { discoverWorkflows, loadCandidate } from '../../../media/discovery.service';
import { testRunWorkflow } from '../../../media/media-generate.service';
import {
  bindingsOf,
  graphOf,
  WORKFLOW_KINDS,
  type WorkflowBindings,
  type WorkflowKind,
} from '../../../domain/media-workflows/media-workflow.model';
import { mediaWorkflowRepository } from '../../../domain/media-workflows/media-workflow.repository';
import type { ComfyGraph } from '../../../media/comfy/types';

const log = createLogger('media-route');

/**
 * The Media page's surface: the ComfyUI connection probe, workflow discovery/import, and CRUD +
 * validation for the stored workflows the media tools run.
 */
export const mediaRouter = Router();

/** Turn an operator-fixable ComfyUI problem into a 400 the UI can display verbatim. */
function fail(res: Parameters<Parameters<typeof mediaRouter.get>[1]>[1], err: unknown): void {
  if (err instanceof ComfyError) {
    res.status(400).json({ error: err.message });
    return;
  }
  log.error({ err: String(err) }, 'media route failed');
  res.status(500).json({ error: 'internal error' });
}

function isKind(value: unknown): value is WorkflowKind {
  return typeof value === 'string' && (WORKFLOW_KINDS as readonly string[]).includes(value);
}

/** Shape a workflow doc for the UI — the graph itself is only sent on the detail route. */
function summarize(doc: Awaited<ReturnType<typeof mediaWorkflowRepository.findById>>) {
  if (!doc) return null;
  const bindings = bindingsOf(doc);
  return {
    id: String(doc._id),
    name: doc.name,
    kind: doc.kind,
    description: doc.description,
    output_node_id: doc.output_node_id,
    output_kind: doc.output_kind,
    source: doc.source,
    enabled: doc.enabled,
    avg_duration_ms: doc.avg_duration_ms,
    node_count: Object.keys(graphOf(doc)).length,
    bound: Object.keys(bindings),
    unbound: relevantKeys(doc.kind as WorkflowKind).filter((k) => !bindings[k]),
    last_validated_at: doc.last_validated_at,
    last_validation_error: doc.last_validation_error,
    updated_at: doc.updated_at,
  };
}

/** Connection probe behind "Test connection": version, queue depth, and per-GPU VRAM. */
mediaRouter.get('/comfy/status', async (_req, res) => {
  try {
    const client = await comfyClient();
    const [stats, queue] = await Promise.all([client.systemStats(), client.queueRemaining()]);
    res.json({
      ok: true,
      base_url: client.baseUrl,
      version: stats.system.comfyui_version,
      python: stats.system.python_version,
      ram_free: stats.system.ram_free,
      ram_total: stats.system.ram_total,
      queue_remaining: queue,
      devices: stats.devices.map((d) => ({
        name: d.name,
        vram_free: d.vram_free,
        vram_total: d.vram_total,
      })),
    });
  } catch (err) {
    // A failed probe is the normal state before the operator has configured anything — answer 200
    // with ok:false so the panel can render the reason inline rather than as a request failure.
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** Workflows ComfyUI has run, grouped and ready to import. */
mediaRouter.get('/comfy/discover', async (_req, res) => {
  try {
    res.json(await discoverWorkflows());
  } catch (err) {
    fail(res, err);
  }
});

mediaRouter.get('/workflows', async (req, res) => {
  const kind = isKind(req.query.kind) ? req.query.kind : undefined;
  const docs = await mediaWorkflowRepository.list(kind);
  res.json(docs.map(summarize));
});

/** Full detail: the graph, its bindings, and every node/input the binding editor can offer. */
mediaRouter.get('/workflows/:id', async (req, res) => {
  const doc = await mediaWorkflowRepository.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const graph = graphOf(doc);
  let nodes: ReturnType<typeof describeNodes> = [];
  try {
    const client = await comfyClient();
    nodes = describeNodes(graph, await loadSchemas(client, graph));
  } catch {
    // No ComfyUI right now: still show the workflow, just without schema-driven input hints.
    nodes = describeNodes(graph, new Map());
  }
  res.json({ ...summarize(doc), bindings: bindingsOf(doc), graph, nodes });
});

/**
 * Import a discovered run as a workflow. The graph is re-read from ComfyUI server-side rather than
 * accepted from the client, and copied into Mongo — ComfyUI's history is in RAM and won't survive its
 * next restart.
 */
mediaRouter.post('/workflows/import', async (req, res) => {
  try {
    const promptId = String(req.body?.prompt_id ?? '');
    if (!promptId) {
      res.status(400).json({ error: 'prompt_id is required' });
      return;
    }
    const { graph, bound, graph_hash, duration_ms, workflow_uuid } = await loadCandidate(promptId);
    const kind = isKind(req.body?.kind) ? req.body.kind : bound.kind;
    const name = String(req.body?.name ?? '').trim() || `Workflow ${promptId.slice(0, 8)}`;

    if (await mediaWorkflowRepository.findByHash(graph_hash)) {
      res.status(409).json({ error: 'That workflow is already imported.' });
      return;
    }

    const doc = await mediaWorkflowRepository.create({
      name,
      kind,
      graph,
      bindings: (req.body?.bindings as WorkflowBindings) ?? bound.bindings,
      output_node_id: bound.output_node_id,
      output_kind: bound.output_kind,
      description: String(req.body?.description ?? ''),
      source: 'discovered',
      source_prompt_id: promptId,
      source_workflow_uuid: workflow_uuid,
      graph_hash,
      avg_duration_ms: duration_ms,
    });
    res.status(201).json(summarize(doc));
  } catch (err) {
    if (err instanceof Error && err.message.includes('duplicate key')) {
      res.status(409).json({ error: 'A workflow with that name already exists.' });
      return;
    }
    fail(res, err);
  }
});

/** Create from a pasted API-format graph (ComfyUI's *Export (API)*), auto-binding it the same way. */
mediaRouter.post('/workflows', async (req, res) => {
  try {
    const graph = req.body?.graph as ComfyGraph | undefined;
    if (!graph || typeof graph !== 'object' || Object.keys(graph).length === 0) {
      res.status(400).json({ error: 'graph is required (ComfyUI → Workflow → Export (API))' });
      return;
    }
    const bad = Object.entries(graph).find(([, node]) => typeof node?.class_type !== 'string');
    if (bad) {
      res.status(400).json({
        error:
          `Node ${bad[0]} has no class_type — this looks like the editor's own workflow format. ` +
          'Use Workflow → Export (API) instead.',
      });
      return;
    }

    const client = await comfyClient();
    const schemas = await loadSchemas(client, graph);
    const bound = autoBind(graph, [], schemas);
    const doc = await mediaWorkflowRepository.create({
      name: String(req.body?.name ?? '').trim() || 'Pasted workflow',
      kind: isKind(req.body?.kind) ? req.body.kind : bound.kind,
      graph,
      bindings: (req.body?.bindings as WorkflowBindings) ?? bound.bindings,
      output_node_id: String(req.body?.output_node_id ?? bound.output_node_id),
      output_kind: bound.output_kind,
      description: String(req.body?.description ?? ''),
      source: 'manual',
      graph_hash: structureHash(graph, schemas),
    });
    res.status(201).json(summarize(doc));
  } catch (err) {
    fail(res, err);
  }
});

/** Rename, re-kind, enable/disable, or correct the bindings. */
mediaRouter.put('/workflows/:id', async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
  if (typeof req.body?.description === 'string') patch.description = req.body.description;
  if (typeof req.body?.notes === 'string') patch.notes = req.body.notes;
  if (isKind(req.body?.kind)) patch.kind = req.body.kind;
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  if (typeof req.body?.output_node_id === 'string') patch.output_node_id = req.body.output_node_id;
  if (['image', 'video', 'audio'].includes(req.body?.output_kind)) patch.output_kind = req.body.output_kind;
  if (req.body?.bindings && typeof req.body.bindings === 'object') patch.bindings = req.body.bindings;

  const doc = await mediaWorkflowRepository.update(req.params.id, patch);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(summarize(doc));
});

mediaRouter.delete('/workflows/:id', async (req, res) => {
  const ok = await mediaWorkflowRepository.remove(req.params.id);
  res.status(ok ? 204 : 404).end();
});

/**
 * Check the workflow against the live ComfyUI: node classes present, bindings still pointing at real
 * inputs, and every model file it names installed. Cheap, and it turns a ten-minute failed run into
 * an instant answer.
 */
mediaRouter.post('/workflows/:id/validate', async (req, res) => {
  try {
    const doc = await mediaWorkflowRepository.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const graph = graphOf(doc);
    const client = await comfyClient();
    const issues = validateWorkflow(graph, bindingsOf(doc), await loadSchemas(client, graph));
    const errors = issues.filter((i) => i.level === 'error');
    await mediaWorkflowRepository.update(req.params.id, {
      last_validated_at: new Date(),
      last_validation_error: errors[0]?.message ?? '',
    });
    res.json({ ok: errors.length === 0, issues });
  } catch (err) {
    fail(res, err);
  }
});

/** Run the workflow once from the Media page, so a binding can be proven rather than assumed. */
mediaRouter.post('/workflows/:id/test', async (req, res) => {
  try {
    const doc = await mediaWorkflowRepository.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const out = await testRunWorkflow(doc, String(req.body?.prompt ?? 'a red apple on a white table'));
    res.json(out);
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Authenticated proxy for ComfyUI's `/view`, used by the Media page's test-run preview. Keeps the
 * operator's browser talking only to this backend — ComfyUI itself has no auth and needn't be
 * reachable from wherever the UI is open.
 */
mediaRouter.get('/view', async (req, res) => {
  try {
    const client = await comfyClient();
    const { bytes, mime } = await client.view({
      filename: String(req.query.filename ?? ''),
      subfolder: String(req.query.subfolder ?? ''),
      type: String(req.query.type ?? 'output'),
    });
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(bytes);
  } catch (err) {
    fail(res, err);
  }
});
