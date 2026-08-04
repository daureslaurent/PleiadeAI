import { createLogger } from '../config/logger';
import { alertEngine } from '../alerts/AlertEngine';
import { settingsService } from '../domain/settings/settings.service';
import { resourceRepository } from '../domain/resources/resource.repository';
import {
  bindingsOf,
  graphOf,
  type MediaWorkflowDoc,
  type WorkflowKind,
} from '../domain/media-workflows/media-workflow.model';
import { mediaWorkflowRepository } from '../domain/media-workflows/media-workflow.repository';
import { comfyClient, type ComfyHttpClient } from './comfy/ComfyHttpClient';
import { ComfyError } from './comfy/errors';
import {
  applyBindings,
  loadSchemas,
  modelFiles,
  validateWorkflow,
  type BindingValues,
} from './comfy/graph-introspect';
import { collectArtifacts, selectArtifacts, type ComfyArtifact, type MediaKind } from './comfy/outputs';
import { runJob } from './comfy/runJob';
import type { ProgressHandler } from './comfy/ComfyProgressSocket';
import type { ComfyGraph } from './comfy/types';

const log = createLogger('media-generate');

/** Ceiling on any single wait, whatever the tool config says. */
export const MAX_WAIT_MS = 30 * 60_000;

export interface InputImage {
  bytes: Buffer;
  filename: string;
  mime: string;
}

export interface GenerateRequest {
  workflowId: string;
  /** The tool's kind — a video tool must not be pointed at an audio workflow. */
  expectKind: WorkflowKind;
  prompt: string;
  negativePrompt?: string;
  /** Bound numeric/string parameters (width, height, length, seconds, fps, batch, seed). */
  values?: BindingValues;
  /** Images to upload and wire into the workflow's `image1..image3` bindings. */
  inputImages?: InputImage[];
  timeoutMs: number;
  onProgress: ProgressHandler;
  /** Fired the moment ComfyUI accepts the job — see {@link MediaRunStart}. */
  onStart?: (info: MediaRunStart) => void;
  signal?: AbortSignal;
  /** Stamped into the output filename prefix so ComfyUI's output folder stays navigable. */
  sessionId?: string;
}

/**
 * What is knowable about a run the instant it is queued, as opposed to when it finishes.
 *
 * A ten-minute video used to reach the UI as a bare percentage because every identifying detail rode
 * on the completion event. Everything here is available seconds after submit, so the operator can see
 * *what* is running — and, from the VRAM figure, guess whether it is about to fail.
 */
export interface MediaRunStart {
  workflow: string;
  workflowKind: WorkflowKind;
  outputKind: 'image' | 'video' | 'audio';
  /** Weight files the graph loads — the clearest statement of what is actually running. */
  models: string[];
  promptId: string;
  /** Base URL of the ComfyUI server, so the card can link to the job. */
  comfyUrl: string;
  /** Jobs ahead of this one when it was queued. */
  queuePosition: number;
  /** Free / total VRAM on the busiest GPU at submit time. 0 when the probe failed. */
  vramFreeBytes: number;
  vramTotalBytes: number;
  seed: number;
}

export interface GeneratedFile {
  bytes: Buffer;
  mime: string;
  filename: string;
  kind: MediaKind;
}

export type GenerateOutcome =
  | {
      status: 'done';
      workflow: MediaWorkflowDoc;
      promptId: string;
      durationMs: number;
      seed: number | null;
      files: GeneratedFile[];
    }
  | { status: 'timeout'; workflow: MediaWorkflowDoc; promptId: string; durationMs: number }
  | { status: 'aborted'; workflow: MediaWorkflowDoc; promptId: string; durationMs: number };

/** Resolve the operator's workflow choice, with an error that says what to do about it. */
async function resolveWorkflow(id: string, expectKind: WorkflowKind): Promise<MediaWorkflowDoc> {
  if (!id) {
    const available = await mediaWorkflowRepository.listEnabled(expectKind);
    throw new ComfyError(
      available.length > 0
        ? `No ${expectKind} workflow is selected for this tool. Pick one on the Tools page ` +
          `(available: ${available.map((w) => w.name).join(', ')}).`
        : `No ${expectKind} workflow has been imported yet. Add one on the Media page ` +
          '(Discover reads them straight out of ComfyUI).',
    );
  }
  const doc = await mediaWorkflowRepository.findById(id);
  if (!doc) {
    throw new ComfyError(
      'The workflow selected for this tool no longer exists. Pick another one on the Tools page.',
    );
  }
  if (!doc.enabled) throw new ComfyError(`Workflow "${doc.name}" is disabled on the Media page.`);
  if (doc.kind !== expectKind) {
    throw new ComfyError(
      `Workflow "${doc.name}" produces ${doc.kind}, not ${expectKind}. Pick a ${expectKind} workflow on the Tools page.`,
    );
  }
  return doc;
}

/** ComfyUI's own default seed is fixed, so an unset seed would return the same picture forever. */
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/**
 * Free/total VRAM on the GPU with the least headroom — the one that decides whether a render fails.
 * Never throws: this is a nicety for the UI, not a precondition for running.
 */
async function busiestGpu(client: ComfyHttpClient): Promise<{ free: number; total: number }> {
  try {
    const stats = await client.systemStats();
    const gpus = stats.devices.filter((d) => d.vram_total > 0);
    if (gpus.length === 0) return { free: 0, total: 0 };
    const worst = gpus.reduce((a, b) => (a.vram_free <= b.vram_free ? a : b));
    return { free: worst.vram_free, total: worst.vram_total };
  } catch {
    return { free: 0, total: 0 };
  }
}

/**
 * Push the caller's images into ComfyUI and return the binding values that point the workflow's
 * `LoadImage` nodes at them. Uploads are named per session/index with `overwrite`, so retries reuse a
 * filename instead of filling the operator's `input/` folder with `photo (7).png`.
 */
async function uploadInputs(
  client: ComfyHttpClient,
  images: InputImage[],
  sessionId: string,
): Promise<BindingValues> {
  const keys = ['image1', 'image2', 'image3'] as const;
  const values: BindingValues = {};
  for (let i = 0; i < images.length && i < keys.length; i += 1) {
    const image = images[i]!;
    const ext = image.filename.split('.').pop()?.toLowerCase() || 'png';
    const name = `pleiades_${sessionId || 'test'}_${i + 1}.${ext}`;
    const up = await client.uploadImage(image.bytes, name, image.mime);
    // LoadImage identifies a file as `subfolder/name` when it isn't at the input root.
    values[keys[i]!] = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
  }
  return values;
}

/**
 * Run a stored workflow on ComfyUI and return the bytes it produced.
 *
 * Everything operator-facing is decided before a single GPU cycle is spent: the workflow exists, is
 * the right kind, its bindings still match its graph, and every model file it names is installed. A
 * ten-minute video failing on a typo'd checkpoint name is the failure mode this ordering exists to
 * prevent.
 */
export async function generateMedia(req: GenerateRequest): Promise<GenerateOutcome> {
  const workflow = await resolveWorkflow(req.workflowId, req.expectKind);
  const client = await comfyClient();
  const settings = await settingsService.get();

  const graph = graphOf(workflow);
  const bindings = bindingsOf(workflow);
  const schemas = await loadSchemas(client, graph);

  const issues = validateWorkflow(graph, bindings, schemas).filter((i) => i.level === 'error');
  if (issues.length > 0) {
    throw new ComfyError(
      `Workflow "${workflow.name}" can't run here: ${issues[0]!.message}` +
        (issues.length > 1 ? ` (+${issues.length - 1} more — see the Media page)` : ''),
    );
  }
  if (!bindings.prompt) {
    // Submitting anyway would run the workflow author's own prompt and pass it off as the agent's.
    throw new ComfyError(
      `Workflow "${workflow.name}" has no prompt binding, so the text would be ignored. ` +
        'Set one on the Media page.',
    );
  }
  if (req.inputImages?.length && !bindings.image1) {
    throw new ComfyError(
      `Workflow "${workflow.name}" takes no input image (no LoadImage node is bound). ` +
        'Pick an edit workflow on the Tools page.',
    );
  }

  const seed = typeof req.values?.seed === 'number' ? req.values.seed : randomSeed();
  const values: BindingValues = {
    ...req.values,
    prompt: req.prompt,
    seed,
    ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
    ...(req.inputImages?.length ? await uploadInputs(client, req.inputImages, req.sessionId ?? '') : {}),
  };
  if (bindings.filename_prefix) {
    values.filename_prefix = `pleiades/${workflow.kind}/${workflow.name.replace(/[^\w-]+/g, '_')}`;
  }

  const submitGraph: ComfyGraph = applyBindings(graph, bindings, values);

  // Preflight the queue and read VRAM in one pass. Both feed the start event, and the queue check is
  // done here rather than inside `runJob` so its depth can be reported instead of just enforced —
  // hence `queueMax: 0` below, which skips the redundant second check.
  const queueMax = settings.comfy_queue_max ?? 0;
  const [queuePosition, vram] = await Promise.all([
    client.queueRemaining().catch(() => 0),
    busiestGpu(client),
  ]);
  if (queueMax > 0 && queuePosition >= queueMax) {
    throw new ComfyError(
      `ComfyUI already has ${queuePosition} job(s) queued and runs one at a time — refusing to pile on. ` +
        'Wait for it to drain, or raise the queue ceiling in Settings → Connections.',
    );
  }

  const outcome = await runJob({
    client,
    graph: submitGraph,
    outputNodeId: workflow.output_node_id || undefined,
    timeoutMs: Math.min(req.timeoutMs, MAX_WAIT_MS),
    queueMax: 0,
    onProgress: req.onProgress,
    onSubmitted: (promptId) =>
      req.onStart?.({
        workflow: workflow.name,
        workflowKind: workflow.kind as WorkflowKind,
        outputKind: workflow.output_kind as 'image' | 'video' | 'audio',
        models: modelFiles(graph),
        promptId,
        comfyUrl: client.baseUrl,
        queuePosition,
        vramFreeBytes: vram.free,
        vramTotalBytes: vram.total,
        seed,
      }),
    signal: req.signal,
  });

  if (outcome.status === 'timeout') {
    return { status: 'timeout', workflow, promptId: outcome.promptId, durationMs: outcome.durationMs };
  }
  if (outcome.status === 'aborted') {
    return { status: 'aborted', workflow, promptId: outcome.promptId, durationMs: outcome.durationMs };
  }

  const wanted = selectArtifacts(outcome.artifacts, workflow.output_kind as MediaKind);
  const files = await downloadAll(client, wanted);
  await mediaWorkflowRepository.recordDuration(String(workflow._id), outcome.durationMs);

  return {
    status: 'done',
    workflow,
    promptId: outcome.promptId,
    durationMs: outcome.durationMs,
    seed,
    files,
  };
}

async function downloadAll(client: ComfyHttpClient, artifacts: ComfyArtifact[]): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const artifact of artifacts) {
    const { bytes, mime } = await client.view(artifact);
    files.push({ bytes, mime, filename: artifact.filename, kind: artifact.kind });
  }
  return files;
}

/**
 * Keep waiting on a job the tool gave up on, then file the result where the operator will find it.
 *
 * The alternative — killing the job at the timeout — throws away GPU time that is already spent and
 * is nearly always the wrong trade for a video that is 90% rendered. Detached completion means the
 * artifact lands in the session's Data tab under its own handle, and the inbox says so.
 */
export function watchDetachedJob(input: {
  promptId: string;
  workflow: MediaWorkflowDoc;
  sessionId: string;
  agentId: string;
  agentName: string;
  /** Give up eventually — a wedged ComfyUI shouldn't leave a poller running forever. */
  graceMs?: number;
}): void {
  const grace = input.graceMs ?? MAX_WAIT_MS;
  const startedAt = Date.now();

  void (async () => {
    try {
      const client = await comfyClient();
      while (Date.now() - startedAt < grace) {
        await new Promise((r) => setTimeout(r, 10_000));
        const entry = await client.historyEntry(input.promptId).catch(() => null);
        if (!entry?.status?.completed) continue;

        const artifacts = selectArtifacts(
          collectArtifacts(entry, input.workflow.output_node_id || undefined),
          input.workflow.output_kind as MediaKind,
        );
        const files = await downloadAll(client, artifacts);
        const handles: string[] = [];
        for (const file of files) {
          const stored = await resourceRepository.store({
            sessionId: input.sessionId,
            agentId: input.agentId,
            bytes: file.bytes,
            kind: file.kind === 'image' ? 'image' : 'blob',
            mime: file.mime,
            filename: file.filename,
            source: 'tool',
          });
          handles.push(stored.handle);
        }
        await alertEngine.dispatch({
          title: `${input.workflow.name} finished`,
          content:
            `The ${input.workflow.kind} job ${input.agentName} started has finished after ` +
            `${Math.round((Date.now() - startedAt) / 1000)}s. Saved as ${handles.join(', ')} — ` +
            'find it in the session\'s Data tab.',
          // The whole point of waiting ten minutes was the artifact — deliver it, don't just
          // announce it. Telegram declines anything too big, and the text alert still lands.
          attachments: files.map((f) => ({
            bytes: f.bytes,
            filename: f.filename,
            mime: f.mime,
          })),
        });
        log.info({ promptId: input.promptId, handles }, 'detached media job landed');
        return;
      }
      log.warn({ promptId: input.promptId }, 'detached media job never completed');
    } catch (err) {
      log.error({ promptId: input.promptId, err: String(err) }, 'detached media watcher failed');
    }
  })();
}

/**
 * One-shot run from the Media page, used to prove a binding is right. Returns the artifact's ComfyUI
 * file reference rather than its bytes — the page previews it through the authenticated `/api/media/view`
 * proxy, so a test render never has to be copied into the session resource store.
 */
export async function testRunWorkflow(
  workflow: MediaWorkflowDoc,
  prompt: string,
): Promise<{ ok: boolean; duration_ms: number; files: { filename: string; subfolder: string; type: string; kind: string }[] }> {
  const client = await comfyClient();
  const graph = graphOf(workflow);
  const bindings = bindingsOf(workflow);
  const settings = await settingsService.get();

  if (!bindings.prompt) throw new ComfyError('This workflow has no prompt binding yet.');

  const submitGraph = applyBindings(graph, bindings, { prompt, seed: randomSeed() });
  const outcome = await runJob({
    client,
    graph: submitGraph,
    outputNodeId: workflow.output_node_id || undefined,
    timeoutMs: MAX_WAIT_MS,
    queueMax: settings.comfy_queue_max ?? 0,
    onProgress: () => {},
  });

  if (outcome.status !== 'done') {
    throw new ComfyError(
      outcome.status === 'timeout'
        ? 'The test run is still going after 30 minutes — check ComfyUI directly.'
        : 'The test run was cancelled.',
    );
  }
  await mediaWorkflowRepository.recordDuration(String(workflow._id), outcome.durationMs);
  return {
    ok: true,
    duration_ms: outcome.durationMs,
    files: outcome.artifacts.map((a) => ({
      filename: a.filename,
      subfolder: a.subfolder,
      type: a.type,
      kind: a.kind,
    })),
  };
}
