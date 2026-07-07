import { eventBus } from '../../core/event-bus/EventBus';
import type {
  AskAgentDonePayload,
  AskAgentPayload,
  ContextUsagePayload,
  StreamChunkPayload,
  ToolCompletePayload,
  ToolInvokePayload,
  ToolOutputChunkPayload,
} from '../../core/event-bus/events.types';

/**
 * Server-side mirror of the frontend stream reducer (`frontend/src/store/stream.ts`).
 *
 * The rich turn view — interleaved prose, tool invocations, and nested sub-agent bubbles — is
 * assembled by the browser from the live event stream and persisted by it on `chat:done`. That
 * loses everything but plain text when the client is gone mid-run (e.g. a page reload during a long
 * orchestration). This recorder consumes the *same* EventBus events for one top-level run and builds
 * an identical `Block[]` tree + debugger trace, so the backend can persist the full turn itself.
 *
 * Kept deliberately in lockstep with the frontend reducer: same block shapes, same coalescing, same
 * frame-stack nesting — so a turn saved here and one saved by the client hydrate identically.
 */

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      status: 'running' | 'success' | 'error';
      result?: unknown;
      images?: { id?: string; dataUrl: string }[];
    }
  | {
      kind: 'agent';
      agent: string;
      from: string;
      depth: number;
      query: string;
      status: 'running' | 'success' | 'error';
      durationMs?: number;
      promptTokens?: number;
      contextWindow?: number;
      children: Block[];
    };

interface TraceEntry {
  kind: 'tool_start' | 'tool_end' | 'hop' | 'reasoning';
  label: string;
  detail?: string;
  status?: 'success' | 'error' | 'info' | 'warn';
  depth?: number;
}

type LiveItem =
  | { kind: 'text'; frameId: string; text: string }
  | { kind: 'reasoning'; frameId: string; text: string }
  | {
      kind: 'tool';
      frameId: string;
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      status: 'running' | 'success' | 'error';
      result?: unknown;
      images?: { id?: string; dataUrl: string }[];
    }
  | { kind: 'agent'; frameId: string; refFrameId: string };

interface Frame {
  agent: string;
  from: string;
  depth: number;
  query: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  durationMs?: number;
  promptTokens?: number;
  contextWindow?: number;
}

/** Pull a human-readable output string out of a tool result (mirrors the frontend helper). */
function resultToOutput(result: unknown): string {
  if (result && typeof result === 'object' && 'output' in result) {
    return String((result as { output: unknown }).output ?? '');
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

export interface RecordedTurn {
  blocks: Block[];
  reasoning: string;
  trace: TraceEntry[];
  contextTokens?: number;
  contextWindow?: number;
}

/** A live item carrying the `id` the frontend store keys its own `LiveItem`s by. */
type SnapshotItem =
  | { kind: 'text'; id: string; frameId: string; text: string }
  | { kind: 'reasoning'; id: string; frameId: string; text: string }
  | {
      kind: 'tool';
      id: string;
      frameId: string;
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      status: 'running' | 'success' | 'error';
      result?: unknown;
      images?: { id?: string; dataUrl: string }[];
    }
  | { kind: 'agent'; id: string; frameId: string; refFrameId: string };

/**
 * Point-in-time mirror of the in-flight turn, shaped so a (re)connecting client can drop it straight
 * into its stream store's live buffer (`liveItems`/`liveFrames`/`frameStack`) and resume streaming.
 * Sent on `session:subscribe` when a run is still live, so a reload/navigation mid-turn no longer
 * shows a truncated turn (missing its start and any already-completed `ask_agent` hops) — the client
 * rebuilds the full turn from here and appends the events that arrive afterwards.
 */
export interface TurnSnapshot {
  sessionId: string;
  items: SnapshotItem[];
  frames: Record<
    string,
    {
      id: string;
      agent: string;
      from: string;
      depth: number;
      query: string;
      status: 'running' | 'success' | 'error';
      startedAt: number;
      durationMs?: number;
      promptTokens?: number;
      contextWindow?: number;
    }
  >;
  frameStack: string[];
  reasoning: string;
  trace: TraceEntry[];
  contextTokens?: number;
  contextWindow?: number;
  /** The recorder's frame-id counter, so the client bumps its own past the adopted `f<n>` ids. */
  seq: number;
}

export class TurnRecorder {
  private readonly items: LiveItem[] = [];
  private readonly frames = new Map<string, Frame>();
  private readonly frameStack: string[] = ['root'];
  private reasoning = '';
  private readonly trace: TraceEntry[] = [];
  private contextTokens?: number;
  private contextWindow?: number;
  private seq = 0;
  private started = false;

  // Bound listeners kept as fields so `stop()` detaches exactly what `start()` attached.
  private readonly onChunk = (p: StreamChunkPayload) => this.handleChunk(p);
  private readonly onToolInvoke = (p: ToolInvokePayload) => this.handleToolInvoke(p);
  private readonly onToolOutput = (p: ToolOutputChunkPayload) => this.handleToolOutput(p);
  private readonly onToolComplete = (p: ToolCompletePayload) => this.handleToolComplete(p);
  private readonly onHop = (p: AskAgentPayload) => this.handleHop(p);
  private readonly onHopDone = (p: AskAgentDonePayload) => this.handleHopDone(p);
  private readonly onContext = (p: ContextUsagePayload) => this.handleContext(p);

  constructor(
    private readonly sessionId: string,
    rootAgent: string,
  ) {
    // Seed the root frame (the directly-addressed agent), matching the frontend's `send`.
    this.frames.set('root', {
      agent: rootAgent,
      from: '',
      depth: 0,
      query: '',
      status: 'running',
      startedAt: Date.now(),
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    eventBus.on('agent:stream_chunk', this.onChunk);
    eventBus.on('agent:tool_invoke', this.onToolInvoke);
    eventBus.on('tool:output_chunk', this.onToolOutput);
    eventBus.on('tool:execution_complete', this.onToolComplete);
    eventBus.on('agent:ask_agent', this.onHop);
    eventBus.on('agent:ask_agent_done', this.onHopDone);
    eventBus.on('agent:context_usage', this.onContext);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    eventBus.off('agent:stream_chunk', this.onChunk);
    eventBus.off('agent:tool_invoke', this.onToolInvoke);
    eventBus.off('tool:output_chunk', this.onToolOutput);
    eventBus.off('tool:execution_complete', this.onToolComplete);
    eventBus.off('agent:ask_agent', this.onHop);
    eventBus.off('agent:ask_agent_done', this.onHopDone);
    eventBus.off('agent:context_usage', this.onContext);
  }

  /** Only events belonging to this run's session are ours (the bus is process-global). */
  private mine(sessionId: string): boolean {
    return sessionId === this.sessionId;
  }

  private get top(): string {
    return this.frameStack[this.frameStack.length - 1] ?? 'root';
  }

  private handleChunk(p: StreamChunkPayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    const kind = p.isReasoning ? ('reasoning' as const) : ('text' as const);
    const last = this.items[this.items.length - 1];
    if (last && last.kind === kind && last.frameId === this.top) {
      last.text += p.content;
    } else {
      this.items.push({ kind, frameId: this.top, text: p.content });
    }
    if (p.isReasoning) this.reasoning += p.content;
  }

  private handleToolInvoke(p: ToolInvokePayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    this.items.push({
      kind: 'tool',
      frameId: this.top,
      callId: p.callId,
      tool: p.tool,
      args: p.args,
      output: '',
      status: 'running',
    });
    this.trace.push({ kind: 'tool_start', label: `▶ ${p.tool}`, detail: JSON.stringify(p.args) });
  }

  private handleToolOutput(p: ToolOutputChunkPayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    for (const it of this.items) {
      if (it.kind === 'tool' && it.callId === p.callId) it.output += p.chunk;
    }
  }

  private handleToolComplete(p: ToolCompletePayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    for (const it of this.items) {
      if (it.kind === 'tool' && it.callId === p.callId) {
        it.status = p.status;
        it.result = p.result;
        it.output = it.output || resultToOutput(p.result);
        if (p.images?.length) {
          it.images = p.images.map((img) => ({ id: img.id, dataUrl: img.dataUrl }));
        }
      }
    }
    this.trace.push({
      kind: 'tool_end',
      label: `■ ${p.tool}`,
      status: p.status,
      detail: resultToOutput(p.result).slice(0, 500),
    });
  }

  private handleHop(p: AskAgentPayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    const parent = this.top;
    const frameId = `f${this.seq++}`;
    this.frames.set(frameId, {
      agent: p.to,
      from: p.from,
      depth: p.depth,
      query: p.query,
      status: 'running',
      startedAt: Date.now(),
    });
    this.items.push({ kind: 'agent', frameId: parent, refFrameId: frameId });
    this.frameStack.push(frameId);
    this.trace.push({ kind: 'hop', label: `${p.from} → ${p.to}`, detail: p.query, depth: p.depth });
  }

  private handleHopDone(p: AskAgentDonePayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    const top = this.top;
    const frame = this.frames.get(top);
    if (frame) {
      frame.status = p.status;
      frame.durationMs = Date.now() - frame.startedAt;
    }
    if (top !== 'root') this.frameStack.pop();
  }

  private handleContext(p: ContextUsagePayload): void {
    if (!this.mine(p.ctx.sessionId)) return;
    // Persist only the settled peak (`final`); the transient `live` readings are UI-only.
    if (p.phase === 'live') return;
    if (p.ctx.depth === 0) {
      this.contextTokens = p.promptTokens;
      this.contextWindow = p.contextWindow;
      return;
    }
    // A sub-agent's usage: attribute it to its own (still-open) frame, matching the frontend.
    const frame = this.frames.get(this.top);
    if (frame && frame.agent === p.ctx.agentName) {
      frame.promptTokens = p.promptTokens;
      frame.contextWindow = p.contextWindow;
    }
  }

  /** Fold the flat log for `frameId` into the nested Block tree (mirrors the frontend `buildBlocks`). */
  private buildBlocks(frameId: string): Block[] {
    const out: Block[] = [];
    for (const it of this.items) {
      if (it.frameId !== frameId) continue;
      if (it.kind === 'text') out.push({ kind: 'text', text: it.text });
      else if (it.kind === 'reasoning') out.push({ kind: 'reasoning', text: it.text });
      else if (it.kind === 'tool') {
        out.push({
          kind: 'tool',
          callId: it.callId,
          tool: it.tool,
          args: it.args,
          output: it.output,
          status: it.status,
          result: it.result,
          images: it.images,
        });
      } else {
        const f = this.frames.get(it.refFrameId);
        if (!f) continue;
        out.push({
          kind: 'agent',
          agent: f.agent,
          from: f.from,
          depth: f.depth,
          query: f.query,
          status: f.status,
          durationMs: f.durationMs,
          promptTokens: f.promptTokens,
          contextWindow: f.contextWindow,
          children: this.buildBlocks(it.refFrameId),
        });
      }
    }
    return out;
  }

  /**
   * Serialize the current live buffer for a (re)connecting client to adopt verbatim. Called
   * synchronously from the `session:subscribe` handler, so it captures a consistent point: no bus
   * event can interleave between this read and the socket emit that follows.
   */
  snapshot(): TurnSnapshot {
    const items: SnapshotItem[] = this.items.map((it, i) => {
      const id = `s${i}`;
      if (it.kind === 'text') return { kind: 'text', id, frameId: it.frameId, text: it.text };
      if (it.kind === 'reasoning')
        return { kind: 'reasoning', id, frameId: it.frameId, text: it.text };
      if (it.kind === 'tool')
        return {
          kind: 'tool',
          id,
          frameId: it.frameId,
          callId: it.callId,
          tool: it.tool,
          args: it.args,
          output: it.output,
          status: it.status,
          result: it.result,
          images: it.images,
        };
      return { kind: 'agent', id, frameId: it.frameId, refFrameId: it.refFrameId };
    });
    const frames: TurnSnapshot['frames'] = {};
    for (const [id, f] of this.frames) frames[id] = { id, ...f };
    return {
      sessionId: this.sessionId,
      items,
      frames,
      frameStack: [...this.frameStack],
      reasoning: this.reasoning,
      trace: [...this.trace],
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
      seq: this.seq,
    };
  }

  /** Assemble the persisted turn. `answer` is the fallback text when the run produced no blocks. */
  build(answer: string): RecordedTurn {
    const built = this.buildBlocks('root');
    const blocks = built.length ? built : [{ kind: 'text' as const, text: answer }];
    const trace = this.reasoning
      ? [...this.trace, { kind: 'reasoning' as const, label: '<think>', detail: this.reasoning }]
      : this.trace;
    return {
      blocks,
      reasoning: this.reasoning,
      trace,
      contextTokens: this.contextTokens,
      contextWindow: this.contextWindow,
    };
  }
}
