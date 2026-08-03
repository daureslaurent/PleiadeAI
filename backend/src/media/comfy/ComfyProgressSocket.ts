import WebSocket from 'ws';
import { createLogger } from '../../config/logger';
import { ComfyExecutionError } from './errors';
import type { ComfyGraph } from './types';

const log = createLogger('comfy-ws');

/** Give up waiting for the socket to come up and run blind rather than not run at all. */
const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 8_000];
/** At most 2 UI updates a second, and only when something actually moved. */
const EMIT_INTERVAL_MS = 500;
/** Percent is noise until enough of the graph has run for the extrapolation to mean anything. */
const ETA_MIN_FRACTION = 0.05;

export interface ComfyProgress {
  phase: 'queued' | 'running' | 'downloading';
  /** 0-100, or null when the run hasn't reported anything measurable yet. */
  percent: number | null;
  /** Id of the node currently executing. */
  node?: string;
  /** Its `_meta.title`, else its class name — what the operator sees in the ComfyUI editor. */
  nodeLabel?: string;
  /** Jobs ahead of ours in ComfyUI's queue (it runs one at a time). */
  queuePosition?: number;
  elapsedMs: number;
  etaMs?: number | null;
  message?: string;
}

export type ProgressHandler = (p: ComfyProgress) => void;

interface TerminalState {
  status: 'success' | 'error';
  error?: ComfyExecutionError;
}

/**
 * Live progress for one ComfyUI job.
 *
 * The ordering that makes this reliable: **connect first, submit second**. `connect()` resolves only
 * once ComfyUI has echoed our own `clientId` back as `sid`, which proves the socket is registered —
 * so there is no window in which a fast job (z-image finishes in 3.5s) could complete before we are
 * listening.
 *
 * The socket is an *optimisation for granularity*, never a correctness dependency: `runJob` polls
 * `/history/{prompt_id}` in parallel throughout, so a socket that never opens, drops, or misses the
 * terminal frame still yields a correct result — just with a coarser progress bar.
 */
export class ComfyProgressSocket {
  private ws: WebSocket | null = null;
  private promptId: string | null = null;
  private closed = false;
  private reconnects = 0;

  private readonly totalNodes: number;
  private readonly labels: Record<string, string>;
  private readonly completed = new Set<string>();
  private currentNode: string | null = null;
  private nodeFraction = 0;
  private startedAt = 0;
  private queueRemaining = 0;

  private lastEmitAt = 0;
  private lastPercent = -1;
  private lastNode: string | null = null;
  private lastPhase: ComfyProgress['phase'] | null = null;
  private terminal: TerminalState | null = null;
  private terminalWaiters: ((t: TerminalState) => void)[] = [];

  constructor(
    private readonly url: string,
    graph: ComfyGraph,
    private readonly onProgress: ProgressHandler,
  ) {
    this.totalNodes = Math.max(1, Object.keys(graph).length);
    this.labels = Object.fromEntries(
      Object.entries(graph).map(([id, node]) => [id, node._meta?.title || node.class_type]),
    );
  }

  /**
   * Open the socket and wait for ComfyUI's opening `status` frame. Resolves `false` (rather than
   * throwing) if it can't connect in time — the caller runs blind instead of failing the job.
   */
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.warn({ url: this.url }, 'progress socket did not open in time — running without it');
        resolve(false);
      }, CONNECT_TIMEOUT_MS);

      this.open(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private open(onReady?: () => void): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      log.warn({ err: String(err) }, 'progress socket could not be created');
      return;
    }
    this.ws = ws;

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // ComfyUI interleaves binary preview frames (the live sampler thumbnail) with JSON events.
      // They are megabytes of PNG we have no use for — never parse them.
      if (isBinary) return;
      let msg: { type?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'status') onReady?.();
      this.handle(msg.type ?? '', msg.data ?? {});
    });

    ws.on('close', () => {
      if (this.closed || this.terminal) return;
      // Dropped mid-job. Reconnect with the *same* clientId so ComfyUI keeps routing our frames.
      const delay = RECONNECT_DELAYS_MS[this.reconnects];
      if (delay === undefined) {
        log.warn({ url: this.url }, 'progress socket gave up reconnecting — polling still covers us');
        return;
      }
      this.reconnects += 1;
      setTimeout(() => this.open(), delay);
    });

    ws.on('error', (err: Error) => {
      log.debug({ err: err.message }, 'progress socket error');
    });
  }

  /** Start accepting events for this job. Called immediately after `POST /prompt` returns. */
  bind(promptId: string): void {
    this.promptId = promptId;
    this.startedAt = Date.now();
    this.emit('queued');
  }

  private handle(type: string, data: Record<string, unknown>): void {
    // The broadcast `status` frame carries no prompt_id and tells us the shared queue depth.
    if (type === 'status') {
      const exec = (data.status as { exec_info?: { queue_remaining?: number } } | undefined)?.exec_info;
      this.queueRemaining = Number(exec?.queue_remaining ?? 0);
      return;
    }
    // Everything else is per-job. Other agents (and the operator's own browser) share this socket's
    // server, so anything not ours is deliberately ignored.
    const id = typeof data.prompt_id === 'string' ? data.prompt_id : null;
    if (!this.promptId || (id && id !== this.promptId)) return;

    switch (type) {
      case 'execution_start':
        this.startedAt = Date.now();
        this.emit('running');
        break;

      case 'execution_cached': {
        // Nodes ComfyUI is skipping because their output is unchanged — they're already "done".
        const nodes = Array.isArray(data.nodes) ? (data.nodes as unknown[]) : [];
        for (const n of nodes) this.completed.add(String(n));
        this.emit('running');
        break;
      }

      case 'executing': {
        const node = data.node == null ? null : String(data.node);
        if (this.currentNode && this.currentNode !== node) this.completed.add(this.currentNode);
        this.currentNode = node;
        this.nodeFraction = 0;
        this.emit('running');
        break;
      }

      case 'progress': {
        // The sampler's step bar for the node currently running.
        const value = Number(data.value ?? 0);
        const max = Number(data.max ?? 0);
        if (data.node != null) this.currentNode = String(data.node);
        this.nodeFraction = max > 0 ? Math.min(1, value / max) : 0;
        this.emit('running');
        break;
      }

      case 'progress_state': {
        // 0.30's aggregate view: every in-flight node with its own value/max. Preferred when present
        // because it accounts for nodes running concurrently.
        const nodes = data.nodes as Record<string, { value?: number; max?: number; state?: string }> | undefined;
        if (!nodes || typeof nodes !== 'object') break;
        let sum = 0;
        let count = 0;
        for (const [nodeId, st] of Object.entries(nodes)) {
          const max = Number(st?.max ?? 0);
          const value = Number(st?.value ?? 0);
          if (st?.state === 'finished' || (max > 0 && value >= max)) {
            this.completed.add(nodeId);
            continue;
          }
          if (max > 0) {
            sum += Math.min(1, value / max);
            count += 1;
            this.currentNode = nodeId;
          }
        }
        this.nodeFraction = count > 0 ? sum / count : this.nodeFraction;
        this.emit('running');
        break;
      }

      case 'executed':
        if (data.node != null) this.completed.add(String(data.node));
        this.emit('running');
        break;

      case 'execution_error': {
        const message = String(data.exception_message ?? 'ComfyUI reported an execution error');
        const traceback = Array.isArray(data.traceback) ? String(data.traceback[0] ?? '') : undefined;
        this.settle({
          status: 'error',
          error: new ComfyExecutionError(message, {
            nodeId: data.node_id == null ? undefined : String(data.node_id),
            nodeType: data.node_type == null ? undefined : String(data.node_type),
            traceback,
          }),
        });
        break;
      }

      case 'execution_success':
        this.settle({ status: 'success' });
        break;

      default:
        break;
    }
  }

  /** Current completion as a 0..1 fraction of the graph, blending finished nodes + the running one. */
  private fraction(): number {
    const done = this.completed.size + this.nodeFraction;
    return Math.max(0, Math.min(1, done / this.totalNodes));
  }

  private emit(phase: ComfyProgress['phase']): void {
    const percent = Math.round(this.fraction() * 100);
    const now = Date.now();
    // Hard rate cap first, then suppress anything the UI would render identically.
    if (now - this.lastEmitAt < EMIT_INTERVAL_MS) return;
    const changed =
      percent !== this.lastPercent || this.currentNode !== this.lastNode || phase !== this.lastPhase;
    if (!changed) return;

    this.lastEmitAt = now;
    this.lastPercent = percent;
    this.lastNode = this.currentNode;
    this.lastPhase = phase;

    const elapsedMs = this.startedAt ? now - this.startedAt : 0;
    const fraction = this.fraction();
    const etaMs =
      fraction > ETA_MIN_FRACTION && elapsedMs > 0
        ? Math.max(0, Math.round(elapsedMs / fraction - elapsedMs))
        : null;

    this.onProgress({
      phase,
      percent,
      node: this.currentNode ?? undefined,
      nodeLabel: this.currentNode ? this.labels[this.currentNode] : undefined,
      queuePosition: Math.max(0, this.queueRemaining - 1),
      elapsedMs,
      etaMs,
    });
  }

  private settle(state: TerminalState): void {
    if (this.terminal) return;
    this.terminal = state;
    for (const waiter of this.terminalWaiters.splice(0)) waiter(state);
  }

  /** Resolves when the socket sees the job finish. Never rejects — the caller inspects the state. */
  waitForTerminal(): Promise<TerminalState> {
    if (this.terminal) return Promise.resolve(this.terminal);
    return new Promise((resolve) => this.terminalWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    this.terminalWaiters.splice(0);
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}
