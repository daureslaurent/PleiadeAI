import { randomUUID } from 'node:crypto';
import { createLogger } from '../../config/logger';
import { ComfyProgressSocket, type ComfyProgress, type ProgressHandler } from './ComfyProgressSocket';
import { ComfyError, ComfyExecutionError, isVramError, VRAM_HINT } from './errors';
import { collectArtifacts, type ComfyArtifact } from './outputs';
import type { ComfyHttpClient } from './ComfyHttpClient';
import type { ComfyGraph, ComfyHistoryEntry } from './types';

const log = createLogger('comfy-job');

/** How often we ask `/history` whether the job landed, independently of the websocket. */
const POLL_INTERVAL_MS = 3_000;
/**
 * ComfyUI writes the history entry as it emits `execution_success`, but the two aren't atomic over
 * the wire — give the entry a moment to appear before declaring the run resultless.
 */
const HISTORY_SETTLE_ATTEMPTS = 5;
const HISTORY_SETTLE_DELAY_MS = 400;

export interface RunJobOptions {
  client: ComfyHttpClient;
  graph: ComfyGraph;
  /** The workflow's declared output node — artifacts from it sort first. */
  outputNodeId?: string;
  /** Wall-clock budget. On expiry the job is left running and `status: 'timeout'` is returned. */
  timeoutMs: number;
  /** Refuse to submit when ComfyUI already has this many jobs queued. 0 disables the check. */
  queueMax: number;
  onProgress: ProgressHandler;
  /**
   * Fired the instant ComfyUI accepts the job, long before it finishes. This is the earliest the run
   * has an identity, and it is what lets the UI name the workflow during a ten-minute render instead
   * of only once the last byte is downloaded.
   */
  onSubmitted?: (promptId: string) => void;
  signal?: AbortSignal;
}

export type RunJobResult =
  | { status: 'done'; promptId: string; artifacts: ComfyArtifact[]; durationMs: number }
  | { status: 'timeout'; promptId: string; durationMs: number }
  | { status: 'aborted'; promptId: string; durationMs: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the failure out of a history entry that ComfyUI filed as an error. */
function errorFromHistory(entry: ComfyHistoryEntry): ComfyExecutionError {
  for (const [name, payload] of entry.status?.messages ?? []) {
    if (name !== 'execution_error') continue;
    const message = String(payload.exception_message ?? 'ComfyUI reported an execution error');
    const traceback = Array.isArray(payload.traceback) ? String(payload.traceback[0] ?? '') : undefined;
    return new ComfyExecutionError(message, {
      nodeId: payload.node_id == null ? undefined : String(payload.node_id),
      nodeType: payload.node_type == null ? undefined : String(payload.node_type),
      traceback,
    });
  }
  return new ComfyExecutionError('ComfyUI reported the run as failed but gave no reason.');
}

/** Decorate a failure with the reason the operator can actually act on. */
function describe(err: ComfyExecutionError): ComfyExecutionError {
  const where = err.nodeType ? ` (node ${err.nodeId ?? '?'} — ${err.nodeType})` : '';
  const hint = isVramError(err.message) ? ` ${VRAM_HINT}` : '';
  return new ComfyExecutionError(`${err.message.trim()}${where}.${hint}`, {
    nodeId: err.nodeId,
    nodeType: err.nodeType,
    traceback: err.traceback,
  });
}

/**
 * Run one graph on ComfyUI end to end: preflight the queue, subscribe, submit, follow progress, and
 * return the artifacts the run produced.
 *
 * Termination is decided by whichever of three signals arrives first — the websocket's terminal
 * frame, the `/history` poll, or the timeout — because none of them is individually trustworthy: the
 * socket can drop, history lags a beat behind the socket, and a wedged job produces neither.
 *
 * On timeout the job is deliberately **left running**. A ten-minute video that has already burned nine
 * minutes of GPU should not be thrown away because the agent's patience ran out; the caller detaches a
 * watcher instead. Only an explicit abort cancels.
 */
export async function runJob(opts: RunJobOptions): Promise<RunJobResult> {
  const { client, graph, outputNodeId, timeoutMs, queueMax, onProgress, onSubmitted, signal } = opts;

  if (signal?.aborted) return { status: 'aborted', promptId: '', durationMs: 0 };

  if (queueMax > 0) {
    const queued = await client.queueRemaining();
    if (queued >= queueMax) {
      throw new ComfyError(
        `ComfyUI already has ${queued} job(s) queued and runs one at a time — refusing to pile on. ` +
          'Wait for it to drain, or raise the queue ceiling in Settings → Connections.',
      );
    }
  }

  // Connect *before* submitting: the socket only counts as live once ComfyUI echoes our own clientId,
  // and a z-image run finishes in ~3.5s — easily inside the window a submit-then-subscribe order
  // would leave open.
  const clientId = randomUUID();
  const socket = new ComfyProgressSocket(client.wsUrl(clientId), graph, onProgress);
  const live = await socket.connect();
  if (!live) log.warn('running without live progress — polling only');

  const startedAt = Date.now();
  let promptId = '';
  try {
    const submitted = await client.submit(graph, clientId);
    promptId = submitted.prompt_id;
    socket.bind(promptId);
    onSubmitted?.(promptId);
    log.info({ promptId, nodes: Object.keys(graph).length, live }, 'submitted to ComfyUI');

    const outcome = await race(client, socket, promptId, timeoutMs, startedAt, signal);
    const durationMs = Date.now() - startedAt;

    if (outcome === 'aborted') {
      await cancel(client, promptId);
      return { status: 'aborted', promptId, durationMs };
    }
    if (outcome === 'timeout') return { status: 'timeout', promptId, durationMs };

    // Settled — read the authoritative record. The socket tells us *when*, history tells us *what*.
    let entry: ComfyHistoryEntry | null = null;
    for (let i = 0; i < HISTORY_SETTLE_ATTEMPTS && !entry; i += 1) {
      entry = await client.historyEntry(promptId);
      if (!entry) await sleep(HISTORY_SETTLE_DELAY_MS);
    }
    if (!entry) {
      throw new ComfyError(
        'ComfyUI finished the job but has no record of it — the server was probably restarted ' +
          '(its queue and history live in memory). Resubmit.',
      );
    }
    if (entry.status?.status_str === 'error') throw describe(errorFromHistory(entry));

    const artifacts = collectArtifacts(entry, outputNodeId);
    if (artifacts.length === 0) {
      throw new ComfyError(
        'The workflow ran but saved nothing. Its output node is probably a Preview rather than a ' +
          'Save node — check the workflow on the Media page.',
      );
    }
    onProgress({ phase: 'downloading', percent: 100, elapsedMs: durationMs, etaMs: 0 });
    return { status: 'done', promptId, artifacts, durationMs };
  } finally {
    socket.close();
  }
}

type Outcome = 'settled' | 'timeout' | 'aborted';

/**
 * Wait for the first of: the socket's terminal frame, a completed `/history` entry, the deadline, or
 * an abort. The poll is what makes a dropped socket survivable.
 */
async function race(
  client: ComfyHttpClient,
  socket: ComfyProgressSocket,
  promptId: string,
  timeoutMs: number,
  startedAt: number,
  signal?: AbortSignal,
): Promise<Outcome> {
  let settledBySocket = false;
  void socket.waitForTerminal().then(() => {
    settledBySocket = true;
  });

  while (true) {
    if (signal?.aborted) return 'aborted';
    if (settledBySocket) return 'settled';
    if (Date.now() - startedAt >= timeoutMs) return 'timeout';

    await sleep(POLL_INTERVAL_MS);

    // Independent of the socket: if the entry exists with a terminal status, the job is over.
    try {
      const entry = await client.historyEntry(promptId);
      if (entry?.status && (entry.status.completed || entry.status.status_str === 'error')) {
        return 'settled';
      }
    } catch (err) {
      // A blip in polling is survivable — the socket or the next tick covers it.
      log.debug({ promptId, err: String(err) }, 'history poll failed');
    }
  }
}

/**
 * Cancel our job without collateral damage. Deleting from the queue is targeted and safe; `/interrupt`
 * is not — it kills whatever is executing — so it only fires once we've confirmed the running job is
 * ours and not another agent's or the operator's own ComfyUI session.
 */
async function cancel(client: ComfyHttpClient, promptId: string): Promise<void> {
  try {
    await client.queueDelete(promptId);
    const info = await client.queueInfo();
    const running = info.queue_running?.some((item) => item?.[1] === promptId);
    if (running) await client.interrupt();
  } catch (err) {
    log.warn({ promptId, err: String(err) }, 'could not cancel ComfyUI job');
  }
}

export type { ComfyProgress, ProgressHandler };
