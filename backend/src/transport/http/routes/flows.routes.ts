import { Router } from 'express';
import multer from 'multer';
import { createLogger } from '../../../config/logger';
import { flowRepository } from '../../../domain/flows/flow.repository';
import { flowRunRepository } from '../../../domain/flows/flow-run.repository';
import type { FlowDoc, FlowEdge, FlowNode } from '../../../domain/flows/flow.model';
import type { FlowRunDoc } from '../../../domain/flows/flow-run.model';
import { flowRunner } from '../../../flows/FlowRunner';
import { flowApprovalBroker } from '../../../flows/FlowApprovalBroker';
import { allHandlers, inputPorts, outputPorts } from '../../../flows/nodes';
import { validateFlow, isRunnable } from '../../../flows/validate';
import { PORT_TYPES } from '../../../flows/port-types';
import { stagingSessionOf } from '../../../flows/staging';
import { resolveDynamicOptions } from '../../../tools/config-options';
import { resourceRepository } from '../../../domain/resources/resource.repository';

const log = createLogger('flows-route');

/**
 * The Flows page's surface: CRUD for saved graphs, the node-type catalogue the canvas builds itself
 * from, validation, and the run lifecycle (start / watch / approve / stop). All behind `requireAuth`
 * (mounted in `index.ts` with `allowQueryToken`, since the run panel previews artifacts with bare
 * `<img>`/`<video>` elements that can't carry a header).
 */
export const flowsRouter = Router();

/**
 * Operator uploads for a flow's `input` nodes. Held in memory then written straight to GridFS — the
 * ceiling matches the ComfyUI server's own upload limit, since a video frame or a source image is the
 * realistic payload here.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 256 * 1024 * 1024 },
});


function summarize(doc: FlowDoc) {
  return {
    id: String(doc._id),
    name: doc.name,
    description: doc.description,
    enabled: doc.enabled,
    nodeCount: doc.nodes?.length ?? 0,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function detail(doc: FlowDoc) {
  const issues = validateFlow(doc);
  return {
    ...summarize(doc),
    nodes: doc.nodes,
    edges: doc.edges,
    issues,
    runnable: isRunnable(issues),
    /** The run form is generated from these — one field per `input` node. */
    inputs: (doc.nodes as FlowNode[])
      .filter((n) => n.type === 'input')
      .map((n) => ({
        nodeId: n.id,
        key: String(n.config?.key ?? '').trim() || n.id,
        label: n.label || String(n.config?.key ?? '') || n.id,
        type: String(n.config?.port_type ?? 'text'),
        default: n.config?.default ?? '',
        required: Boolean(n.config?.required),
      })),
  };
}

function runSummary(doc: FlowRunDoc) {
  return {
    id: String(doc._id),
    flowId: doc.flow_id,
    flowName: doc.flow_name,
    status: doc.status,
    trigger: doc.trigger,
    sessionId: doc.session_id,
    startedAt: doc.started_at,
    endedAt: doc.ended_at,
    error: doc.error || undefined,
  };
}

/**
 * The node catalogue (flows spec §3) — the canvas's single source of truth. `optionsSource` fields
 * are resolved here rather than in the client, so a select of "your ComfyUI image workflows" is
 * current at the moment the palette opens.
 */
flowsRouter.get('/node-types', async (_req, res) => {
  const types = await Promise.all(
    allHandlers().map(async (handler) => ({
      type: handler.type,
      label: handler.label,
      group: handler.group,
      description: handler.description,
      inputs: handler.inputs,
      outputs: handler.outputs,
      config: await resolveDynamicOptions(handler.config, {}),
    })),
  );
  res.json({ types, portTypes: PORT_TYPES });
});

flowsRouter.get('/', async (_req, res) => {
  const flows = await flowRepository.list();
  res.json(flows.map(summarize));
});

flowsRouter.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (await flowRepository.findByName(name)) {
    res.status(409).json({ error: `a flow named "${name}" already exists` });
    return;
  }
  const doc = await flowRepository.create({
    name,
    description: String(req.body?.description ?? ''),
    enabled: req.body?.enabled !== false,
    nodes: (req.body?.nodes ?? []) as FlowNode[],
    edges: (req.body?.edges ?? []) as FlowEdge[],
  });
  res.status(201).json(detail(doc));
});

flowsRouter.get('/:id', async (req, res) => {
  const doc = await flowRepository.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  res.json(detail(doc));
});

flowsRouter.put('/:id', async (req, res) => {
  const existing = await flowRepository.findById(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) {
    const clash = await flowRepository.findByName(req.body.name.trim());
    if (clash && String(clash._id) !== req.params.id) {
      res.status(409).json({ error: `a flow named "${req.body.name.trim()}" already exists` });
      return;
    }
    patch.name = req.body.name.trim();
  }
  if (typeof req.body?.description === 'string') patch.description = req.body.description;
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  if (Array.isArray(req.body?.nodes)) patch.nodes = req.body.nodes;
  if (Array.isArray(req.body?.edges)) patch.edges = req.body.edges;

  const doc = await flowRepository.update(req.params.id, patch);
  res.json(doc ? detail(doc) : { error: 'flow not found' });
});

flowsRouter.delete('/:id', async (req, res) => {
  const removed = await flowRepository.remove(req.params.id);
  if (!removed) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  await flowRunRepository.removeByFlow(req.params.id);
  res.json({ ok: true });
});

/** Duplicate a flow, ids and all — the fastest way to try a variant without risking the original. */
flowsRouter.post('/:id/duplicate', async (req, res) => {
  const source = await flowRepository.findById(req.params.id);
  if (!source) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  let name = `${source.name} copy`;
  for (let i = 2; await flowRepository.findByName(name); i += 1) name = `${source.name} copy ${i}`;

  const doc = await flowRepository.create({
    name,
    description: source.description,
    enabled: source.enabled,
    nodes: source.nodes as FlowNode[],
    edges: source.edges as FlowEdge[],
  });
  res.status(201).json(detail(doc));
});

/** Validate an unsaved graph — the canvas calls this as you wire, before anything is persisted. */
flowsRouter.post('/validate', (req, res) => {
  const issues = validateFlow({
    nodes: (req.body?.nodes ?? []) as FlowNode[],
    edges: (req.body?.edges ?? []) as FlowEdge[],
  } as Pick<FlowDoc, 'nodes' | 'edges'>);
  res.json({ issues, runnable: isRunnable(issues) });
});

/**
 * Start a run. Returns as soon as the run document exists so the client can subscribe to its socket
 * room and watch — a flow with a video node runs for ten minutes, far past any HTTP timeout.
 */
flowsRouter.post('/:id/run', async (req, res) => {
  const flow = await flowRepository.findById(req.params.id);
  if (!flow) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  const issues = validateFlow(flow);
  if (!isRunnable(issues)) {
    res.status(400).json({ error: issues.find((i) => i.level === 'error')?.message, issues });
    return;
  }

  const inputs = (req.body?.inputs ?? {}) as Record<string, unknown>;

  // Answer with the run id as soon as the run document exists, and never wait for the run itself —
  // a flow with a video node runs for ten minutes, far past any HTTP timeout. The id arrives through
  // `onRunCreated` rather than a lookup-after-the-fact, which is a race the caller loses.
  let settleId: (id: string | null) => void;
  const runId = new Promise<string | null>((resolve) => {
    settleId = resolve;
  });

  const started = flowRunner
    .start({ flow, trigger: 'manual', inputs, onRunCreated: (id) => settleId(id) })
    .catch((err: unknown) => {
      // Nothing was created (validation, or a failure before the document existed).
      settleId(null);
      throw err;
    });

  // A failure this early is the operator's mistake, not a run outcome — surface it as a 400.
  const outcome = await Promise.race([
    runId.then((id) => ({ id })),
    started.then(() => ({ id: null })).catch((err: unknown) => ({ error: err })),
  ]);
  if ('error' in outcome) {
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    res.status(400).json({ error: message });
    return;
  }

  started.catch((err: unknown) => log.error({ err: String(err), flow: flow.name }, 'flow run failed'));

  const run = outcome.id ? await flowRunRepository.findById(outcome.id) : null;
  res.status(202).json(run ? runSummary(run) : { status: 'running' });
});

flowsRouter.get('/runs/list', async (req, res) => {
  const flowId = typeof req.query.flowId === 'string' && req.query.flowId ? req.query.flowId : undefined;
  const runs = await flowRunRepository.list(flowId, Number(req.query.limit) || 50);
  res.json(runs.map(runSummary));
});

/** Full run detail: per-node states, the pending gate, the output — what the run panel renders. */
flowsRouter.get('/runs/:runId', async (req, res) => {
  const run = await flowRunRepository.findById(req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'run not found' });
    return;
  }
  const resources = await resourceRepository.listBySession(run.session_id || String(run._id));
  res.json({
    ...runSummary(run),
    inputs: run.inputs,
    nodes: run.nodes,
    logs: run.logs ?? [],
    pending: run.pending,
    output: run.output,
    live: flowRunner.isRunning(String(run._id)),
    resources: resources.map((r) => ({
      handle: r.handle,
      kind: r.kind,
      mime: r.mime,
      size: r.size,
      filename: r.filename || undefined,
    })),
  });
});

/** Answer an `approval` gate. 409 when the run isn't parked on one (already answered, or restarted). */
flowsRouter.post('/runs/:runId/approve', async (req, res) => {
  const approved = req.body?.approved !== false;
  const delivered = await flowApprovalBroker.answer(req.params.runId, approved);
  if (!delivered) {
    res.status(409).json({ error: 'this run is not waiting for an approval' });
    return;
  }
  res.json({ ok: true, approved });
});

flowsRouter.post('/runs/:runId/stop', (req, res) => {
  const stopped = flowRunner.stop(req.params.runId);
  if (!stopped) {
    res.status(409).json({ error: 'this run is not active' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Upload a file for one of the flow's `input` nodes. Returns the handle to put in the input's value
 * (or its default), plus enough metadata for the UI to preview it.
 */
flowsRouter.post('/:id/uploads', upload.single('file'), async (req, res) => {
  // multer's handler overload widens `params`, so narrow it back rather than casting `req`.
  const flow = await flowRepository.findById(String(req.params.id));
  if (!flow) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'a file is required (multipart field "file")' });
    return;
  }

  const mime = file.mimetype || 'application/octet-stream';
  const stored = await resourceRepository.store({
    sessionId: stagingSessionOf(String(flow._id)),
    agentId: String(flow._id),
    bytes: file.buffer,
    // Images get an `img_` handle so they can enter a model's context downstream; everything else is
    // an opaque blob reached by handle, exactly as elsewhere in the resource store.
    kind: mime.startsWith('image/') ? 'image' : 'blob',
    mime,
    filename: file.originalname,
    source: 'attachment',
  });

  log.info({ flow: flow.name, handle: stored.handle, size: file.size }, 'flow input uploaded');
  res.status(201).json({
    handle: stored.handle,
    filename: stored.filename || file.originalname,
    mime: stored.mime,
    size: stored.size,
    kind: stored.kind,
    sessionId: stagingSessionOf(String(flow._id)),
  });
});

/** Files already staged for this flow, so the run form can offer them instead of a re-upload. */
flowsRouter.get('/:id/uploads', async (req, res) => {
  const flow = await flowRepository.findById(req.params.id);
  if (!flow) {
    res.status(404).json({ error: 'flow not found' });
    return;
  }
  const sessionId = stagingSessionOf(String(flow._id));
  const rows = await resourceRepository.listBySession(sessionId);
  res.json({
    sessionId,
    files: rows.map((r) => ({
      handle: r.handle,
      filename: r.filename || undefined,
      mime: r.mime,
      size: r.size,
      kind: r.kind,
      createdAt: r.created_at,
    })),
  });
});

/** Ports a node currently exposes — the canvas refetches this when a router's choices change. */
flowsRouter.post('/ports', (req, res) => {
  const node = req.body?.node as FlowNode | undefined;
  if (!node?.type) {
    res.status(400).json({ error: 'node is required' });
    return;
  }
  res.json({ inputs: inputPorts(node), outputs: outputPorts(node) });
});
