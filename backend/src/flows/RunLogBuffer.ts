import { createLogger } from '../config/logger';
import { eventBus } from '../core/event-bus/EventBus';
import { flowRunRepository } from '../domain/flows/flow-run.repository';
import type { FlowLogEntry, FlowLogSource } from '../domain/flows/flow-run.model';

const log = createLogger('flow-log');

/** Bytes of trace kept per node. Oldest lines are dropped first once a node exceeds this. */
const MAX_BYTES_PER_NODE = 8 * 1024;

/** Hard ceiling on entries for the whole run, so a hundred-node graph still can't balloon the doc. */
const MAX_ENTRIES = 4000;

/** Longest single line kept; a tool that prints a 2MB blob gets cut, not stored. */
const MAX_LINE = 2000;

/** How often the buffer is written to Mongo while a run is live. */
const FLUSH_INTERVAL_MS = 2000;

interface Tracked extends FlowLogEntry {
  bytes: number;
}

/**
 * The run's debug trace (flows spec §6.2).
 *
 * Two problems this exists to solve. First, **write volume**: an agent node streams tokens, so
 * persisting per chunk would be thousands of round trips for one turn — entries are buffered here and
 * flushed on a timer. Second, **unbounded growth**: a chatty `bash` node inside a 20-item loop would
 * otherwise push the run document toward Mongo's 16MB ceiling, so each node keeps a rolling
 * {@link MAX_BYTES_PER_NODE} window. The cap is per *node* rather than per run on purpose: a global
 * cap would let one noisy node evict every other node's lines, which is exactly the trace you still
 * need when that node is the one misbehaving.
 *
 * It also subscribes to the agent / tool / media events emitted *inside* the run. Those already flow
 * on the bus keyed by the run's session id (a flow run's sessionId is its run id, spec §1.1), so
 * folding them in is a matter of listening — the reasoning behind an `ask_agent` node's answer lands
 * in the same stream as the node's own output, in order.
 */
export class RunLogBuffer {
  private entries: Tracked[] = [];
  private bytesByNode = new Map<string, number>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly detach: Array<() => void> = [];

  constructor(private readonly runId: string) {}

  /**
   * Start mirroring the agent/tool/media chatter of this run's session into the trace. The listeners
   * are scoped by session id, so two flows running at once never see each other's lines.
   */
  attach(): void {
    const mine = (ctx: { sessionId: string }): boolean => ctx.sessionId === this.runId;

    // Agent reasoning + answer tokens. Coalesced by the per-node byte cap rather than here: a
    // token-by-token entry list is what makes the "what was it thinking" replay actually useful.
    const onChunk = (p: { ctx: { sessionId: string; agentName: string }; content: string; isReasoning?: boolean }) => {
      if (!mine(p.ctx)) return;
      this.append(this.currentNode, 'agent', p.content, { coalesce: true });
    };
    eventBus.on('agent:stream_chunk', onChunk);
    this.detach.push(() => eventBus.off('agent:stream_chunk', onChunk));

    const onToolStart = (p: { ctx: { sessionId: string }; tool: string; args: Record<string, unknown> }) => {
      if (!mine(p.ctx)) return;
      this.append(this.currentNode, 'tool', `→ ${p.tool}(${summarizeArgs(p.args)})`);
    };
    eventBus.on('agent:tool_invoke', onToolStart);
    this.detach.push(() => eventBus.off('agent:tool_invoke', onToolStart));

    const onToolEnd = (p: { ctx: { sessionId: string }; tool: string; status: string; durationMs: number }) => {
      if (!mine(p.ctx)) return;
      this.append(this.currentNode, 'tool', `← ${p.tool} ${p.status} (${Math.round(p.durationMs)}ms)`);
    };
    eventBus.on('tool:execution_complete', onToolEnd);
    this.detach.push(() => eventBus.off('tool:execution_complete', onToolEnd));

    const onToolOutput = (p: { ctx: { sessionId: string }; chunk: string }) => {
      if (!mine(p.ctx)) return;
      this.append(this.currentNode, 'tool', p.chunk, { coalesce: true });
    };
    eventBus.on('tool:output_chunk', onToolOutput);
    this.detach.push(() => eventBus.off('tool:output_chunk', onToolOutput));

    const onMedia = (p: { ctx: { sessionId: string }; phase: string; kind: string; workflow: string; prompt: string }) => {
      if (!mine(p.ctx)) return;
      if (p.phase !== 'start') return;
      this.append(this.currentNode, 'media', `${p.kind} · ${p.workflow} · "${p.prompt.slice(0, 120)}"`);
    };
    eventBus.on('agent:media_generated', onMedia);
    this.detach.push(() => eventBus.off('agent:media_generated', onMedia));
  }

  /**
   * The node those ambient events belong to.
   *
   * An agent turn's own events carry the *agent's* identity, not the flow node's, so the runner
   * stamps the executing node here. Nodes in one region run concurrently, so this is a best-effort
   * attribution — good enough for reading a trace, and the alternative (threading a node id through
   * the whole agent runner) would put flow concerns inside the agent layer.
   */
  private currentNode = 'flow';

  setCurrentNode(nodeId: string): void {
    this.currentNode = nodeId;
  }

  /** Record a line. `coalesce` appends to the previous entry when it is the same node + source. */
  append(
    nodeId: string,
    source: FlowLogSource,
    text: string,
    opts: { iteration?: number; coalesce?: boolean } = {},
  ): void {
    if (!text) return;
    const clipped = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;

    const last = this.entries[this.entries.length - 1];
    if (opts.coalesce && last && last.node_id === nodeId && last.source === source) {
      // Streaming tokens arrive a few characters at a time; one entry per token would make the trace
      // unreadable and blow the entry ceiling within a sentence.
      last.text += clipped;
      const grew = Buffer.byteLength(clipped);
      last.bytes += grew;
      this.bytesByNode.set(nodeId, (this.bytesByNode.get(nodeId) ?? 0) + grew);
    } else {
      const bytes = Buffer.byteLength(clipped);
      this.entries.push({
        at: new Date(),
        node_id: nodeId,
        source,
        text: clipped,
        iteration: opts.iteration ?? null,
        bytes,
      });
      this.bytesByNode.set(nodeId, (this.bytesByNode.get(nodeId) ?? 0) + bytes);
    }

    this.evict(nodeId);
    this.dirty = true;
    this.schedule();
  }

  /** Drop this node's oldest lines until it is back under the cap, then enforce the global ceiling. */
  private evict(nodeId: string): void {
    let bytes = this.bytesByNode.get(nodeId) ?? 0;
    while (bytes > MAX_BYTES_PER_NODE) {
      const index = this.entries.findIndex((e) => e.node_id === nodeId);
      if (index < 0) break;
      const [dropped] = this.entries.splice(index, 1);
      bytes -= dropped!.bytes;
    }
    this.bytesByNode.set(nodeId, Math.max(0, bytes));

    while (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.shift();
      if (!dropped) break;
      this.bytesByNode.set(dropped.node_id, Math.max(0, (this.bytesByNode.get(dropped.node_id) ?? 0) - dropped.bytes));
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Write the buffer out. Called on the timer and once more when the run ends. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = this.entries.map(({ bytes: _bytes, ...entry }) => entry);
    try {
      await flowRunRepository.setLogs(this.runId, snapshot);
    } catch (err) {
      // A trace that fails to persist must never fail the run it is describing.
      log.warn({ runId: this.runId, err: String(err) }, 'failed to persist flow run logs');
    }
  }

  /** Detach the listeners and write the final state. */
  async close(): Promise<void> {
    for (const off of this.detach) off();
    this.detach.length = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

/** Compact one-line rendering of a tool call's arguments for the trace. */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}: ${String(rendered).slice(0, 60)}`);
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}
