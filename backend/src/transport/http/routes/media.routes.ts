import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { comfyClient } from '../../../media/comfy/ComfyHttpClient';
import { ComfyError } from '../../../media/comfy/errors';
import {
  autoBind,
  describeNodes,
  hydrateBindings,
  loadSchemas,
  modelFiles,
  outputKindOf,
  relevantKeys,
  structureHash,
  validateWorkflow,
  type SchemaMap,
} from '../../../media/comfy/graph-introspect';
import { discoverWorkflows, loadCandidate } from '../../../media/discovery.service';
import { testRunWorkflow } from '../../../media/media-generate.service';
import { bindingCatalog, customCatalog } from '../../../domain/media-workflows/binding-meta';
import {
  BINDING_KEYS,
  bindingsOf,
  customBindings,
  customName,
  CUSTOM_KEY_RE,
  graphOf,
  MAX_CUSTOM_BINDINGS,
  WORKFLOW_KINDS,
  type WorkflowBindings,
  type WorkflowKind,
} from '../../../domain/media-workflows/media-workflow.model';
import { mediaWorkflowRepository } from '../../../domain/media-workflows/media-workflow.repository';
import { flowRepository } from '../../../domain/flows/flow.repository';
import { ToolConfigModel } from '../../../domain/tools/tool-config.model';
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

/**
 * Node schemas for a graph, or an empty map when ComfyUI is unreachable.
 *
 * Every read path degrades this way on purpose: a stored workflow is a snapshot, so it stays
 * inspectable and re-bindable with the server down. Only validate and run genuinely need the live
 * schemas, and both say so in their own error.
 */
async function schemasFor(graph: ComfyGraph): Promise<SchemaMap> {
  try {
    return await loadSchemas(await comfyClient(), graph);
  } catch {
    return new Map();
  }
}

/**
 * Who runs this workflow: the media tools whose Tools-page config selects it, and every node of every
 * saved flow that does.
 *
 * The Media page could previously tell an operator a binding was wrong but not *what* would run with
 * it — the workflow id lives in a tool config and in flow node configs, three pages away. Answering it
 * here is what turns "the prompt binding is on the negative encoder" into "…and that is why the
 * Storyboard flow's Generate Image node ignores you".
 */
async function consumersOf(workflowId: string): Promise<{ kind: 'tool' | 'flow'; name: string; detail: string }[]> {
  const out: { kind: 'tool' | 'flow'; name: string; detail: string }[] = [];

  const toolConfigs = await ToolConfigModel.find({}, { name: 1, config: 1, enabled: 1 }).lean();
  for (const doc of toolConfigs) {
    const config = (doc.config ?? {}) as Record<string, unknown>;
    if (String(config.workflow ?? '') !== workflowId) continue;
    out.push({ kind: 'tool', name: doc.name, detail: doc.enabled === false ? 'tool disabled' : 'Tools page' });
  }

  for (const flow of await flowRepository.list()) {
    for (const node of flow.nodes ?? []) {
      if (String((node.config as Record<string, unknown>)?.workflow ?? '') !== workflowId) continue;
      out.push({
        kind: 'flow',
        name: flow.name,
        detail: `${node.label || node.type} node${flow.enabled ? '' : ' · flow disabled'}`,
      });
    }
  }
  return out;
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

/**
 * The catalog of logical parameters, with labels, port types and where each value comes from at run
 * time. Static per kind, so the mapping canvas fetches it once and renders its app-side ports from it
 * rather than hard-coding a key list that drifts from the backend's.
 */
mediaRouter.get('/binding-keys', (req, res) => {
  res.json(bindingCatalog(isKind(req.query.kind) ? req.query.kind : undefined));
});

/** Full detail: the graph, its bindings, every node/input the canvas draws, and who runs it. */
mediaRouter.get('/workflows/:id', async (req, res) => {
  const doc = await mediaWorkflowRepository.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const graph = graphOf(doc);
  // No ComfyUI right now: still show the workflow, just without schema-driven input hints.
  const nodes = describeNodes(graph, await schemasFor(graph));
  res.json({
    ...summarize(doc),
    bindings: bindingsOf(doc),
    /** The app-side ports for this workflow's own invented parameters, beside the static catalog. */
    custom_catalog: customCatalog(bindingsOf(doc)),
    graph,
    nodes,
    models: modelFiles(graph),
    notes: doc.notes,
    graph_hash: doc.graph_hash,
    source_prompt_id: doc.source_prompt_id,
    consumers: await consumersOf(String(doc._id)),
  });
});

/**
 * Re-run the auto-binder and return what it *would* bind, without saving.
 *
 * Two cases need this: a workflow imported while ComfyUI was down (bound with no schemas, so every
 * numeric constraint is missing), and one whose graph the operator has since re-imported. Returning a
 * proposal rather than writing it keeps the operator's hand-corrected bindings safe — the canvas shows
 * the diff and they choose.
 */
mediaRouter.post('/workflows/:id/autobind', async (req, res) => {
  try {
    const doc = await mediaWorkflowRepository.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const graph = graphOf(doc);
    const bound = autoBind(graph, doc.output_node_id ? [doc.output_node_id] : [], await schemasFor(graph));
    res.json({
      bindings: bound.bindings,
      output_node_id: bound.output_node_id,
      output_kind: bound.output_kind,
      kind: bound.kind,
      unbound: bound.unbound,
    });
  } catch (err) {
    fail(res, err);
  }
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

/**
 * Unwrap whatever the operator pasted into an API-format graph.
 *
 * Three things legitimately arrive here: the bare `{nodeId: {class_type…}}` map that *Export (API)*
 * writes, the same thing under a `prompt` key (which is how it looks when copied out of a `/history`
 * entry or a `POST /prompt` body), and the editor's own save format — which has a `nodes` array and is
 * *not* submittable, so it gets its own error rather than a confusing one about `class_type`.
 */
function unwrapGraph(
  body: Record<string, unknown> | undefined,
): { graph: ComfyGraph; error?: undefined } | { error: string; graph?: undefined } {
  const candidates = [body?.graph, body?.prompt, body].filter(
    (c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object',
  );
  for (const candidate of candidates) {
    if (Array.isArray((candidate as { nodes?: unknown }).nodes)) {
      return {
        error:
          "That is the ComfyUI editor's own workflow format (it has a `nodes` array), which can't be " +
          'submitted as-is. In ComfyUI use Workflow → Export (API) and paste that file instead.',
      };
    }
    const entries = Object.entries(candidate).filter(([key]) => !key.startsWith('_'));
    if (entries.length === 0) continue;
    if (entries.every(([, node]) => typeof (node as { class_type?: unknown })?.class_type === 'string')) {
      return { graph: Object.fromEntries(entries) as ComfyGraph };
    }
  }
  return {
    error:
      'No API-format graph found in that JSON. It should be a map of node id → { class_type, inputs } ' +
      '(ComfyUI → Workflow → Export (API)).',
  };
}

/** Create from a pasted API-format graph (ComfyUI's *Export (API)*), auto-binding it the same way. */
mediaRouter.post('/workflows', async (req, res) => {
  try {
    const { graph, error } = unwrapGraph(req.body as Record<string, unknown> | undefined);
    if (!graph) {
      res.status(400).json({ error });
      return;
    }

    // Import must not depend on a reachable ComfyUI: the graph is a snapshot, and binding it with no
    // schemas still produces a usable workflow — Validate fills in the constraints once the server is
    // back, and Auto-map re-runs the binder with them.
    const schemas = await schemasFor(graph);
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

/**
 * Check the custom half of a binding map the client sent.
 *
 * Built-in keys are a closed set and need no checking, but a `custom:` key is operator-invented and
 * travels a long way — it becomes a flow node's port name and, when `agent_editable`, a JSON-schema
 * property in a tool's arguments. Both of those want a plain identifier, and neither can be fixed
 * later without breaking the flows already wired to it. Returns the first problem, or null.
 */
function customBindingError(bindings: WorkflowBindings): string | null {
  const custom = customBindings(bindings);
  if (custom.length > MAX_CUSTOM_BINDINGS) {
    return `A workflow may declare at most ${MAX_CUSTOM_BINDINGS} custom inputs.`;
  }
  for (const [key, binding] of custom) {
    if (!CUSTOM_KEY_RE.test(key)) {
      return `"${key}" is not a valid custom input name — use custom:<lower_snake_case>, e.g. custom:category.`;
    }
    if ((BINDING_KEYS as readonly string[]).includes(customName(key))) {
      return `"${customName(key)}" is already a built-in parameter — pick another name.`;
    }
    if (binding.choices !== undefined) {
      if (!Array.isArray(binding.choices) || binding.choices.some((c) => typeof c !== 'string')) {
        return `The choices for "${customName(key)}" must be a list of strings.`;
      }
      const cleaned = binding.choices.map((c) => c.trim()).filter(Boolean);
      if (cleaned.length !== binding.choices.length) {
        return `The choices for "${customName(key)}" contain a blank entry.`;
      }
      if (
        binding.default !== undefined &&
        binding.default !== '' &&
        !cleaned.includes(String(binding.default))
      ) {
        return `The default for "${customName(key)}" must be one of its choices (${cleaned.join(', ')}).`;
      }
    }
  }
  return null;
}

/**
 * Just the parameters one workflow invents, without its graph.
 *
 * The flows inspector needs these to draw a media node's per-workflow fields and ports, and asking for
 * the full detail route would drag a whole ComfyUI graph — plus a `/object_info` round trip per node
 * class — across the wire on every workflow change.
 */
mediaRouter.get('/workflows/:id/params', async (req, res) => {
  const doc = await mediaWorkflowRepository.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(customCatalog(bindingsOf(doc)));
});

/** Rename, re-kind, enable/disable, or correct the bindings. */
mediaRouter.put('/workflows/:id', async (req, res) => {
  const existing = await mediaWorkflowRepository.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
  if (typeof req.body?.description === 'string') patch.description = req.body.description;
  if (typeof req.body?.notes === 'string') patch.notes = req.body.notes;
  if (isKind(req.body?.kind)) patch.kind = req.body.kind;
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;

  const graph = graphOf(existing);
  const needsSchemas =
    (req.body?.bindings && typeof req.body.bindings === 'object') ||
    typeof req.body?.output_node_id === 'string';
  const schemas = needsSchemas ? await schemasFor(graph) : new Map();

  if (req.body?.bindings && typeof req.body.bindings === 'object') {
    const problem = customBindingError(req.body.bindings as WorkflowBindings);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    // Hydrated rather than stored as sent: the editor knows the node and input, the server knows the
    // schema constraints that make a numeric binding safe to clamp.
    patch.bindings = hydrateBindings(graph, req.body.bindings as WorkflowBindings, schemas);
  }
  if (typeof req.body?.output_node_id === 'string') {
    patch.output_node_id = req.body.output_node_id;
    // The result node decides the media type, so re-derive it here. Otherwise repointing a graph at
    // its `SaveVideo` would leave `output_kind: image`, and the run would pick the wrong artifact.
    if (req.body.output_node_id) {
      patch.output_kind = outputKindOf(graph[req.body.output_node_id]?.class_type ?? '');
    }
  }
  // An explicit choice still wins over the derivation above.
  if (['image', 'video', 'audio'].includes(req.body?.output_kind)) patch.output_kind = req.body.output_kind;

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
