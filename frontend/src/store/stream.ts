import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { sessionsApi, scoringApi, type StoredMessage } from '../lib/api';
import { useAuth } from './auth';
import type {
  AgentHopEvent,
  AgentHopDoneEvent,
  AskUserEvent,
  ContextUsageEvent,
  StreamChunkEvent,
  SystemAlertEvent,
  ToolEndEvent,
  ToolOutputEvent,
  ToolStartEvent,
  TruncatedEvent,
  TurnScoredEvent,
  MemoryRecallEvent,
  RecalledMemory,
  VisionEvent,
  ImageGenEvent,
  VisualActEvent,
} from '../lib/ws-events.types';

export type { RecalledMemory };

/** Session context size shown in the chat header (prompt tokens vs the model's context window). */
export interface ContextUsage {
  promptTokens: number;
  contextWindow: number;
}

/** Ordered pieces of an assistant turn: prose interleaved with inline tool blocks. */
/** Vision analysis surfaced on a `visual_screenshot` tool block (screenshot + the model's answer). */
export interface VisionInfo {
  image: string;
  question: string;
  answer: string;
  model: string;
  /** Located pixel (localize mode) + coordinate space, so the vision card marks it on the preview. */
  x?: number | null;
  y?: number | null;
  width?: number;
  height?: number;
  /** Set when the located point was snapped to an OCR text box — shows an "OCR" chip on the card. */
  snap?: { text: string; x: number; y: number } | null;
}

/** Generation metadata surfaced on a `generate_image` tool block (prompt + params + model). The
 * images themselves live on the block's `images` (from `tool_end`); this frames them as a generation. */
export interface ImageGenInfo {
  prompt: string;
  size: string;
  n: number;
  steps: number;
  guidance: number;
  seed: number | null;
  negativePrompt: string | null;
  model: string;
  count: number;
}

/** Where a `visual_act` call acted: a screenshot + the marked pixel(s), surfaced on its tool block. */
export interface VisualActInfo {
  image: string;
  width: number;
  height: number;
  action: string;
  x: number | null;
  y: number | null;
  x2?: number | null;
  y2?: number | null;
  /** Set when a visual_click target was snapped to an OCR text box — shows an "OCR" chip. */
  snap?: { text: string; x: number; y: number } | null;
}

export type Block =
  | { kind: 'text'; text: string }
  /** The agent's streamed `<think>` reasoning, rendered as a collapsible thinking block. */
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'tool';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      status: 'running' | 'success' | 'error';
      result?: unknown;
      /** Images the tool read/acquired into the turn (e.g. a picture read via `read`), keyed by handle. */
      images?: { id?: string; dataUrl: string }[];
      /** Vision analysis attached to a `visual_screenshot` call: screenshot thumbnail + the model's answer. */
      vision?: VisionInfo;
      /** Generation metadata attached to a `generate_image` call: prompt + params + model. */
      imageGen?: ImageGenInfo;
      /** Action marker attached to a `visual_act` call: screenshot + where the action landed. */
      visualAct?: VisualActInfo;
    }
  /**
   * A delegated sub-agent run (`ask_agent`). Rendered as a nested, color-coded bubble at the exact
   * point in the parent's stream where the hop occurred; `children` is the sub-agent's own block
   * tree (recursively, so agent→agent→agent nests visually).
   */
  | {
      kind: 'agent';
      agent: string;
      from: string;
      depth: number;
      query: string;
      status: 'running' | 'success' | 'error';
      durationMs?: number;
      /** Prompt tokens the sub-agent's run consumed (its live context size), once it reports. */
      promptTokens?: number;
      /** Model context window, so the bubble can show usage as a fraction. */
      contextWindow?: number;
      /** This sub-agent run's id — the scored unit; lets its own quality score attach to this bubble. */
      runId?: string;
      /** The Conversation Quality score for this sub-agent run, once the scorer has judged it. */
      score?: TurnScore;
      /** Memories auto-recalled into this sub-agent's own prompt (its bubble gets its own badge). */
      memories?: RecalledMemory[];
      children: Block[];
    };

/**
 * Flat, append-only live event log for the in-flight turn. Each item is tagged with the `frameId`
 * of the agent that produced it, so `buildBlocks` can fold the log back into the nested `Block`
 * tree. Kept flat (not a live tree) so every socket update is a cheap immutable array push/patch.
 */
type LiveItem =
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
      vision?: VisionInfo;
      imageGen?: ImageGenInfo;
      visualAct?: VisualActInfo;
    }
  /** Placeholder marking where a child agent frame was spawned within this frame's stream. */
  | { kind: 'agent'; id: string; frameId: string; refFrameId: string };

/** One agent invocation in the live call tree (`root` = the directly-addressed agent, depth 0). */
interface LiveFrame {
  id: string;
  agent: string;
  from: string;
  depth: number;
  query: string;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  durationMs?: number;
  /** Prompt tokens the run reported (context_usage), attributed to this frame's bubble. */
  promptTokens?: number;
  contextWindow?: number;
  /** The sub-agent run's id (from the `agent_hop` event) — the scored unit for this bubble. */
  runId?: string;
  /** Memories the auto-RAG step injected into this frame's prompt, if any. */
  memories?: RecalledMemory[];
}

/**
 * The in-flight turn as the backend's `TurnRecorder` currently holds it, sent on `session:subscribe`
 * when a run is still live (see `backend/src/transport/ws/TurnRecorder.ts`). Its `items`/`frames`
 * shapes match `LiveItem`/`LiveFrame` so `chat:snapshot` can adopt them into the live buffer as-is
 * and resume — the turn's start and any earlier `ask_agent` hops survive a mid-run reload/navigation.
 */
interface TurnSnapshot {
  sessionId: string;
  items: LiveItem[];
  frames: Record<string, LiveFrame>;
  frameStack: string[];
  reasoning: string;
  trace: TraceEntry[];
  contextTokens?: number;
  contextWindow?: number;
  seq: number;
}

let itemSeq = 0;
const nextId = () => `i${itemSeq++}`;

/** Fold the flat live log for `frameId` into an ordered, nested `Block[]` tree. */
export function buildBlocks(
  frameId: string,
  items: LiveItem[],
  frames: Record<string, LiveFrame>,
): Block[] {
  const out: Block[] = [];
  for (const it of items) {
    if (it.frameId !== frameId) continue;
    if (it.kind === 'text') {
      out.push({ kind: 'text', text: it.text });
    } else if (it.kind === 'reasoning') {
      out.push({ kind: 'reasoning', text: it.text });
    } else if (it.kind === 'tool') {
      out.push({
        kind: 'tool',
        callId: it.callId,
        tool: it.tool,
        args: it.args,
        output: it.output,
        status: it.status,
        result: it.result,
        images: it.images,
        vision: it.vision,
        imageGen: it.imageGen,
        visualAct: it.visualAct,
      });
    } else {
      const f = frames[it.refFrameId];
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
        runId: f.runId,
        memories: f.memories,
        children: buildBlocks(it.refFrameId, items, frames),
      });
    }
  }
  return out;
}

/**
 * Attach `score` to the sub-agent bubble whose run is `runId`, walking the nested `agent` block tree.
 * Returns a new tree only if a match was found (else the same reference, so callers can no-op). Used
 * to land a delegated sub-agent's Conversation Quality score on its own bubble, live and on backfill.
 */
function attachScoreToBubble(blocks: Block[], runId: string, score: TurnScore): { blocks: Block[]; changed: boolean } {
  let changed = false;
  const next = blocks.map((b) => {
    if (b.kind !== 'agent') return b;
    if (b.runId === runId) {
      changed = true;
      return { ...b, score };
    }
    const inner = attachScoreToBubble(b.children, runId, score);
    if (inner.changed) {
      changed = true;
      return { ...b, children: inner.blocks };
    }
    return b;
  });
  return changed ? { blocks: next, changed } : { blocks, changed };
}

/** A Conversation Quality score attached to an assistant turn (from the scorer). */
export interface TurnScore {
  score: number;
  tag: 'Perfect' | 'Patched' | 'Recovered' | 'Rejected';
  explanation: string;
}

export type Turn =
  | { role: 'user'; blocks: [{ kind: 'text'; text: string }]; images?: string[] }
  | {
      role: 'assistant';
      blocks: Block[];
      /** The backend turn id (present once a turn completes) — groups this turn's parent + sub-agent runs. */
      turnId?: string;
      /** The depth-0 agent-run id — the scored unit this top-level turn's quality score keys on. */
      runId?: string;
      /** The Conversation Quality score for the top-level run, once the scorer has judged it. */
      score?: TurnScore;
      /** Memories auto-recalled into the top-level run's prompt — the turn header's "memories" badge. */
      memories?: RecalledMemory[];
    };

/** Raw trace entries for the debugger drawer (kept alongside the inline blocks). */
export interface TraceEntry {
  kind: 'tool_start' | 'tool_end' | 'hop' | 'alert' | 'reasoning';
  label: string;
  detail?: string;
  status?: 'success' | 'error' | 'info' | 'warn';
  depth?: number;
}

interface StreamState {
  /** Session currently rendered in the chat panel. */
  activeSessionId: string | null;
  turns: Turn[];
  /** Flat append-only log of the in-flight turn; folded into a nested tree by `buildBlocks`. */
  liveItems: LiveItem[];
  /** Every agent frame spawned this turn, keyed by frame id (`root` = directly-addressed agent). */
  liveFrames: Record<string, LiveFrame>;
  /** Ids of the currently-open frames; the last entry is the agent actively streaming right now. */
  frameStack: string[];
  liveReasoning: string;
  trace: TraceEntry[];
  /** Settled context size (blue "total") — the last turn's peak. Null until the first turn completes. */
  contextUsage: ContextUsage | null;
  /**
   * Transient in-turn context size (amber "live"), set from per-iteration readings while a turn runs
   * and cleared when it settles. Non-null only during an active turn; drives the amber overlay + the
   * ghost tick (which sits at `contextUsage`, the prior total).
   */
  liveContext: ContextUsage | null;
  /** An agent is blocking on `ask_user`; drives the operator prompt modal. Null when nothing waits. */
  pendingAsk: { requestId: string; agent: string; question: string } | null;
  /**
   * The most recent `visual_act` marker, so the live desktop panel can flash a transient pulse where
   * the agent just acted. `ts` re-triggers the animation on each new action; `agentId` lets a panel
   * ignore actions from other agents.
   */
  lastVisualAct: (VisualActInfo & { agentId: string; ts: number }) | null;
  /**
   * The last turn on the active session was cut off by the tool-round cap (agent stopped mid-task).
   * Drives the composer's auto-continue: it re-nudges only when this is set, never after a clean
   * finish. Cleared when a new turn starts.
   */
  lastTurnTruncated: boolean;
  streaming: boolean;
  /** Session ids with an in-flight agent run — drives the per-session "working" shimmer. */
  workingSessions: string[];
  /**
   * Reference-counted running agents *by name*. An agent is "working" when count > 0, whether it
   * was messaged directly or invoked by another agent via `ask_agent`. Counting handles the same
   * agent being busy across concurrent sessions/hops without a premature clear.
   */
  workingAgents: Record<string, number>;
  /** sessionId → the directly-addressed agent, so `chat:done` can decrement the right one. */
  sessionAgent: Record<string, string>;
  wired: boolean;
  /** trace length captured when the current turn started, so we can persist only its delta. */
  turnTraceStart: number;
  wire: () => void;
  /** Load a persisted session's messages into the panel (reconstructs chat + debugger). */
  hydrate: (sessionId: string, messages: StoredMessage[]) => void;
  clearActive: () => void;
  send: (agentName: string, content: string, sessionId: string, images?: string[]) => void;
  /** Ask the backend to stop the in-flight run for the active session (the "stop" button). */
  stop: () => void;
  /** Send the operator's answer to a pending `ask_user`, unblocking the waiting agent run. */
  answerAsk: (answer: string) => void;
}

/** Pull a human-readable output string out of a tool result (bash returns `{ output }`). */
function resultToOutput(result: unknown): string {
  if (result && typeof result === 'object' && 'output' in result) {
    return String((result as { output: unknown }).output ?? '');
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

/** Return a new working-agents map with `name`'s reference count adjusted by `delta` (clamped ≥0). */
function bumpAgent(map: Record<string, number>, name: string, delta: number): Record<string, number> {
  const next = { ...map };
  const count = (next[name] ?? 0) + delta;
  if (count > 0) next[name] = count;
  else delete next[name];
  return next;
}

/** Flatten rendered turns into the text-only history the model consumes. */
function turnsToHistory(turns: Turn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns.map((t) => ({
    role: t.role,
    content: t.blocks
      .map((b) =>
        b.kind === 'text'
          ? b.text
          : b.kind === 'reasoning'
            ? '' // the model's own hidden thoughts — never fed back into history
            : b.kind === 'tool'
              ? `[${b.tool}]`
              : `[ask_agent → ${b.agent}]`,
      )
      .join('')
      .trim(),
  }));
}

export const useStream = create<StreamState>((set, get) => ({
  activeSessionId: null,
  turns: [],
  liveItems: [],
  liveFrames: {},
  frameStack: ['root'],
  liveReasoning: '',
  trace: [],
  contextUsage: null,
  liveContext: null,
  pendingAsk: null,
  lastVisualAct: null,
  lastTurnTruncated: false,
  streaming: false,
  workingSessions: [],
  workingAgents: {},
  sessionAgent: {},
  wired: false,
  turnTraceStart: 0,

  wire: () => {
    if (get().wired) return;
    const socket = getSocket();

    // The backend rejects the handshake for a missing/expired/invalid JWT. Treat that as a session
    // expiry: log out so the AuthGuard login window replaces the workspace instead of a dead socket.
    socket.on('connect_error', (err: Error) => {
      const reason = err.message.toLowerCase();
      if (reason.includes('auth') || reason.includes('token') || reason.includes('unauthorized')) {
        useAuth.getState().logout();
      }
    });

    socket.on('stream_chunk', (e: StreamChunkEvent) => {
      set((s) => {
        const top = s.frameStack[s.frameStack.length - 1] ?? 'root';
        const items = [...s.liveItems];
        const last = items[items.length - 1];
        // Reasoning and output are both frame-scoped: coalesce consecutive chunks of the *same*
        // kind from the *same* frame into one item (a frame boundary or a kind switch starts a new
        // one), so each agent/subagent gets its own thinking block + answer without bleeding.
        const kind = e.is_reasoning ? ('reasoning' as const) : ('text' as const);
        if (last && last.kind === kind && last.frameId === top) {
          items[items.length - 1] = { ...last, text: last.text + e.content };
        } else {
          items.push({ kind, id: nextId(), frameId: top, text: e.content });
        }
        // Keep the flat global reasoning string too — the debugger drawer's Trace tab renders it.
        return e.is_reasoning
          ? { liveItems: items, liveReasoning: s.liveReasoning + e.content }
          : { liveItems: items };
      });
    });

    socket.on('tool_start', (e: ToolStartEvent) => {
      set((s) => {
        const top = s.frameStack[s.frameStack.length - 1] ?? 'root';
        return {
          liveItems: [
            ...s.liveItems,
            {
              kind: 'tool',
              id: nextId(),
              frameId: top,
              callId: e.callId,
              tool: e.tool,
              args: e.args,
              output: '',
              status: 'running',
            },
          ],
          trace: [
            ...s.trace,
            { kind: 'tool_start', label: `▶ ${e.tool}`, detail: JSON.stringify(e.args) },
          ],
        };
      });
    });

    socket.on('tool_output', (e: ToolOutputEvent) => {
      set((s) => ({
        liveItems: s.liveItems.map((it) =>
          it.kind === 'tool' && it.callId === e.callId ? { ...it, output: it.output + e.chunk } : it,
        ),
      }));
    });

    // Vision analysis of a visual_screenshot: attach the thumbnail + Q&A to its tool block.
    socket.on('vision', (e: VisionEvent) => {
      set((s) => ({
        liveItems: s.liveItems.map((it) =>
          it.kind === 'tool' && it.callId === e.callId
            ? {
                ...it,
                vision: {
                  image: e.image,
                  question: e.question,
                  answer: e.answer,
                  model: e.model,
                  x: e.x,
                  y: e.y,
                  width: e.width,
                  height: e.height,
                  snap: e.snap,
                },
              }
            : it,
        ),
      }));
    });

    // Generation card for a generate_image call: attach the prompt + params + model to its tool block.
    // The images themselves land via `tool_end` (as the block's `images`), so this only adds framing.
    socket.on('image_gen', (e: ImageGenEvent) => {
      set((s) => ({
        liveItems: s.liveItems.map((it) =>
          it.kind === 'tool' && it.callId === e.callId
            ? {
                ...it,
                imageGen: {
                  prompt: e.prompt,
                  size: e.size,
                  n: e.n,
                  steps: e.steps,
                  guidance: e.guidance,
                  seed: e.seed,
                  negativePrompt: e.negativePrompt,
                  model: e.model,
                  count: e.count,
                },
              }
            : it,
        ),
      }));
    });

    // Action marker for a visual_act: attach the screenshot + marked pixel to its tool block, and
    // stash it as `lastVisualAct` so an open live desktop can flash a pulse where the agent acted.
    socket.on('visual_act', (e: VisualActEvent) => {
      const info: VisualActInfo = {
        image: e.image,
        width: e.width,
        height: e.height,
        action: e.action,
        x: e.x,
        y: e.y,
        x2: e.x2,
        y2: e.y2,
        snap: e.snap,
      };
      set((s) => ({
        liveItems: s.liveItems.map((it) =>
          it.kind === 'tool' && it.callId === e.callId ? { ...it, visualAct: info } : it,
        ),
        lastVisualAct: { ...info, agentId: e.agentId, ts: Date.now() },
      }));
    });

    socket.on('tool_end', (e: ToolEndEvent) => {
      set((s) => ({
        liveItems: s.liveItems.map((it) =>
          it.kind === 'tool' && it.callId === e.callId
            ? {
                ...it,
                status: e.status,
                result: e.result,
                images: e.images,
                output: it.output || resultToOutput(e.result),
              }
            : it,
        ),
        trace: [
          ...s.trace,
          {
            kind: 'tool_end',
            label: `■ ${e.tool}`,
            status: e.status,
            detail: resultToOutput(e.result).slice(0, 500),
          },
        ],
      }));
    });

    socket.on('agent_hop', (e: AgentHopEvent) => {
      set((s) => {
        // Runs are a strict stack (a parent `ask_agent` awaits its child), so the new frame nests
        // under whichever frame is currently streaming. Drop a placeholder in the parent's log to
        // pin the sub-agent bubble at the exact spot the hop happened.
        const parent = s.frameStack[s.frameStack.length - 1] ?? 'root';
        const frameId = `f${itemSeq++}`;
        return {
          liveFrames: {
            ...s.liveFrames,
            [frameId]: {
              id: frameId,
              agent: e.to,
              from: e.from,
              depth: e.depth,
              query: e.query,
              status: 'running',
              startedAt: Date.now(),
              runId: e.childRunId,
            },
          },
          liveItems: [
            ...s.liveItems,
            { kind: 'agent', id: nextId(), frameId: parent, refFrameId: frameId },
          ],
          frameStack: [...s.frameStack, frameId],
          trace: [
            ...s.trace,
            { kind: 'hop', label: `${e.from} → ${e.to}`, detail: e.query, depth: e.depth },
          ],
          // The delegated agent is now working (fired for a sub-agent `ask_agent` call).
          workingAgents: bumpAgent(s.workingAgents, e.to, +1),
        };
      });
    });

    socket.on('agent_hop_done', (e: AgentHopDoneEvent) => {
      set((s) => {
        const top = s.frameStack[s.frameStack.length - 1];
        const frame = top ? s.liveFrames[top] : undefined;
        // Close the top frame (pop the stack) and stamp its outcome + duration for the summary chip.
        const liveFrames =
          top && frame
            ? {
                ...s.liveFrames,
                [top]: { ...frame, status: e.status, durationMs: Date.now() - frame.startedAt },
              }
            : s.liveFrames;
        return {
          liveFrames,
          frameStack: top && top !== 'root' ? s.frameStack.slice(0, -1) : s.frameStack,
          workingAgents: bumpAgent(s.workingAgents, e.to, -1),
        };
      });
    });

    socket.on('system_alert', (e: SystemAlertEvent) => {
      set((s) => ({ trace: [...s.trace, { kind: 'alert', label: e.message, status: e.level }] }));
    });

    socket.on('ask_user', (e: AskUserEvent) => {
      // Only surface the prompt when it belongs to the session currently on screen.
      set((s) =>
        e.sessionId === s.activeSessionId
          ? { pendingAsk: { requestId: e.requestId, agent: e.agent, question: e.question } }
          : {},
      );
    });

    // Memories the auto-RAG step injected into a run's prompt. Attributed to the frame that consumed
    // them — the root frame for the turn's own badge, a sub-agent's frame for its bubble — so both
    // ride the existing frame → block plumbing (and the snapshot/persist paths) unchanged.
    socket.on('memory_recall', (e: MemoryRecallEvent) => {
      if (e.sessionId !== get().activeSessionId) return;
      set((s) => {
        const frameId = e.depth === 0 ? 'root' : s.frameStack[s.frameStack.length - 1];
        const frame = frameId ? s.liveFrames[frameId] : undefined;
        // A sub-agent's recall lands just before its first token, so the top frame is still its own.
        if (!frameId || !frame || (e.depth > 0 && frame.agent !== e.agent)) return {};
        return { liveFrames: { ...s.liveFrames, [frameId]: { ...frame, memories: e.memories } } };
      });
    });

    socket.on('context_usage', (e: ContextUsageEvent) => {
      // Only reflect the on-screen session; background runs update their own persisted messages.
      if (e.sessionId !== get().activeSessionId) return;
      if (e.depth === 0) {
        // The user-facing agent drives the session header meter. A `live` reading is the transient
        // amber overlay (context climbing mid-turn); `final` is the settled blue total (this turn's
        // peak), which also clears the amber so the bar rests on the total between turns.
        const reading = { promptTokens: e.promptTokens, contextWindow: e.contextWindow };
        set(e.phase === 'live' ? { liveContext: reading } : { contextUsage: reading, liveContext: null });
        return;
      }
      // A delegated sub-agent: attribute its usage to its own live frame. Its run reports just
      // before `agent_hop_done` pops the stack, so the top frame is still this sub-agent's.
      set((s) => {
        const top = s.frameStack[s.frameStack.length - 1];
        const frame = top ? s.liveFrames[top] : undefined;
        if (!top || !frame || frame.agent !== e.agent) return {};
        return {
          liveFrames: {
            ...s.liveFrames,
            [top]: { ...frame, promptTokens: e.promptTokens, contextWindow: e.contextWindow },
          },
        };
      });
    });

    // The active session's turn was cut off by the tool-round cap. Record it so the composer can
    // offer / auto-fire a "continue"; it's cleared the moment the next turn starts.
    socket.on('truncated', (e: TruncatedEvent) => {
      if (e.sessionId !== get().activeSessionId) return;
      set({ lastTurnTruncated: true });
    });

    // A run is still in flight for a session we just re-opened (e.g. the user refreshed mid-turn).
    // Reflect the working state so the UI doesn't look stopped; the terminal `chat:done` (broadcast
    // to the room) will resolve it.
    socket.on('chat:running', ({ sessionId }: { sessionId: string }) => {
      set((s) =>
        sessionId === s.activeSessionId
          ? {
              streaming: true,
              lastTurnTruncated: false,
              workingSessions: s.workingSessions.includes(sessionId)
                ? s.workingSessions
                : [...s.workingSessions, sessionId],
            }
          : {},
      );
    });

    // The backend's mirror of an in-flight turn, sent right after `chat:running` when we re-subscribe
    // to a session whose run is still going (a reload or in-app navigation dropped/reset our buffer).
    // Adopt it wholesale as the live buffer so the turn's already-streamed prose and earlier
    // `ask_agent` bubbles reappear; the events that keep arriving then append onto this base. Bump
    // the id counter past the adopted `f<n>` frame ids so a later hop can't reuse one.
    socket.on('chat:snapshot', (snap: TurnSnapshot) => {
      set((s) => {
        if (snap.sessionId !== s.activeSessionId) return {};
        itemSeq = Math.max(itemSeq, snap.seq);
        return {
          streaming: true,
          lastTurnTruncated: false,
          liveItems: snap.items,
          liveFrames: snap.frames,
          frameStack: snap.frameStack.length ? snap.frameStack : ['root'],
          liveReasoning: snap.reasoning,
          // Replace any previously-adopted live trace (idempotent if the snapshot arrives twice),
          // keeping the persisted trace that precedes this turn intact.
          trace: [...s.trace.slice(0, s.turnTraceStart), ...snap.trace],
          contextUsage:
            snap.contextTokens !== undefined
              ? { promptTokens: snap.contextTokens, contextWindow: snap.contextWindow ?? 0 }
              : s.contextUsage,
        };
      });
    });

    socket.on(
      'chat:done',
      ({
        sessionId,
        answer,
        persisted,
        blocks: serverBlocks,
        memories: serverMemories,
        turnId,
        runId,
      }: {
        sessionId: string;
        answer: string;
        persisted?: boolean;
        /** Rich blocks the backend assembled when it persisted the turn itself (client was gone). */
        blocks?: Block[];
        /** Memories the backend recorded for the top-level run when it persisted the turn itself. */
        memories?: RecalledMemory[];
        /** Backend turn id — groups this turn's parent + sub-agent runs. */
        turnId?: string;
        /** Depth-0 agent-run id — tag the saved turn so its quality score attaches on refresh. */
        runId?: string;
      }) => {
      const s = get();
      const directAgent = s.sessionAgent[sessionId];
      const { [sessionId]: _drop, ...restSessionAgent } = s.sessionAgent;

      // Global bookkeeping (independent of which session is on screen). A run ending clears any
      // unanswered prompt it left dangling (the backend already rejected the blocked `ask_user`).
      const shared = {
        workingSessions: s.workingSessions.filter((id) => id !== sessionId),
        workingAgents: directAgent ? bumpAgent(s.workingAgents, directAgent, -1) : s.workingAgents,
        sessionAgent: restSessionAgent,
        pendingAsk: sessionId === s.activeSessionId ? null : s.pendingAsk,
      };

      // Only the on-screen session may consume the shared live buffer; background runs just persist
      // their plain answer so their thread stays correct when reopened.
      if (sessionId === s.activeSessionId) {
        // When the server persisted this turn (client was gone mid-run), render the rich blocks it
        // reconstructed — tools + sub-agent hops included — falling back to plain text. The local
        // live buffer is at best partial in that case. Otherwise fold the live buffer as usual.
        const built = buildBlocks('root', s.liveItems, s.liveFrames);
        const blocks: Block[] = persisted
          ? serverBlocks && serverBlocks.length
            ? serverBlocks
            : [{ kind: 'text', text: answer }]
          : built.length
            ? built
            : [{ kind: 'text', text: answer }];
        const hasContent = persisted
          ? blocks.length > 0
          : s.liveItems.length > 0 || answer.trim().length > 0;
        const trace = s.liveReasoning
          ? [...s.trace, { kind: 'reasoning' as const, label: '<think>', detail: s.liveReasoning }]
          : s.trace;
        // The top-level run's recall lives on the root frame (or comes back with a server-persisted
        // turn); it settles onto the turn so the badge stays with the message.
        const memories = persisted ? serverMemories : s.liveFrames.root?.memories;

        set({
          ...shared,
          streaming: false,
          turns: hasContent
            ? [...s.turns, { role: 'assistant', blocks, turnId, runId, memories }]
            : s.turns,
          liveItems: [],
          liveFrames: {},
          frameStack: ['root'],
          liveReasoning: '',
          trace,
          // Safety net: the `final` context reading normally clears this just before `chat:done`;
          // drop it here too so a stopped/errored turn never leaves the amber overlay stuck.
          liveContext: null,
        });

        // `persisted` → the backend already saved this turn (client was absent at completion); don't
        // write a duplicate.
        if (hasContent && !persisted) {
          void sessionsApi
            .addMessage(sessionId, {
              role: 'assistant',
              text: answer,
              blocks,
              reasoning: s.liveReasoning || undefined,
              trace: trace.slice(s.turnTraceStart),
              memories,
              context_tokens: s.contextUsage?.promptTokens,
              context_window: s.contextUsage?.contextWindow,
              turn_id: turnId,
              run_id: runId,
            })
            .catch(() => {});
        }
      } else {
        set(shared);
        if (answer.trim() && !persisted) {
          void sessionsApi
            .addMessage(sessionId, { role: 'assistant', text: answer, blocks: [{ kind: 'text', text: answer }] })
            .catch(() => {});
        }
      }
    });

    // Conversation Quality Scorer: attach a live score to the matching agent-run (by run id) in the
    // on-screen session. The depth-0 run lands on the top-level turn; a sub-agent run lands on its own
    // nested bubble (found by walking the block tree). Other sessions are updated on their next hydrate.
    socket.on('turn_scored', (e: TurnScoredEvent) => {
      set((s) => {
        if (e.sessionId && e.sessionId !== s.activeSessionId) return s;
        const score: TurnScore = { score: e.score, tag: e.tag, explanation: e.explanation };
        let changed = false;
        const turns = s.turns.map((t) => {
          if (t.role !== 'assistant') return t;
          // Depth-0 run → the top-level turn's own badge.
          if (t.runId === e.runId) {
            changed = true;
            return { ...t, score };
          }
          // Otherwise it may be a sub-agent run nested in this turn's blocks (scope by turnId to avoid
          // walking unrelated turns).
          if (t.turnId && t.turnId === e.turnId) {
            const res = attachScoreToBubble(t.blocks, e.runId, score);
            if (res.changed) {
              changed = true;
              return { ...t, blocks: res.blocks };
            }
          }
          return t;
        });
        return changed ? { turns } : s;
      });
    });

    set({ wired: true });
  },

  hydrate: (sessionId, messages) => {
    // Re-attach to this session's room so a run still in flight (e.g. started before a refresh)
    // keeps streaming here and its terminal `chat:done` lands — the backend replies `chat:running`
    // if it's still going. `wire()` (called on boot) has already registered the listeners.
    get().wire();
    getSocket().emit('session:subscribe', { sessionId });

    const turns: Turn[] = messages.map((m) =>
      m.role === 'user'
        ? { role: 'user', blocks: [{ kind: 'text', text: m.text }], images: m.images?.length ? m.images : undefined }
        : {
            role: 'assistant',
            blocks: (m.blocks as Block[] | undefined) ?? [{ kind: 'text', text: m.text }],
            turnId: m.turn_id,
            runId: m.run_id,
            memories: m.memories as RecalledMemory[] | undefined,
          },
    );
    const trace: TraceEntry[] = messages.flatMap((m) => (m.trace as TraceEntry[] | undefined) ?? []);

    // Backfill quality scores for this session's runs (survives refresh): fetch the session's scores
    // (one per agent-run) and attach each by run id — the depth-0 run to its top-level turn, each
    // sub-agent run to its nested bubble. Fire-and-forget so hydrate stays synchronous.
    void scoringApi
      .list({ sessionId, limit: 500 })
      .then((scores) => {
        if (get().activeSessionId !== sessionId || scores.length === 0) return;
        const byRun = new Map(scores.map((sc) => [sc.runId, sc]));
        set((s) => ({
          turns: s.turns.map((t) => {
            if (t.role !== 'assistant') return t;
            let turn = t;
            // Top-level (depth-0) run → the turn's own badge.
            const own = t.runId ? byRun.get(t.runId) : undefined;
            if (own) turn = { ...turn, score: { score: own.score, tag: own.tag, explanation: own.explanation } };
            // Sub-agent runs → nested bubbles. Attach every score whose bubble lives in this turn.
            let blocks = turn.blocks;
            for (const sc of scores) {
              if (sc.runId === t.runId) continue;
              const res = attachScoreToBubble(blocks, sc.runId, { score: sc.score, tag: sc.tag, explanation: sc.explanation });
              if (res.changed) blocks = res.blocks;
            }
            if (blocks !== turn.blocks) turn = { ...turn, blocks };
            return turn;
          }),
        }));
      })
      .catch(() => {});
    // Restore the context meter from the most recent assistant turn that recorded it.
    const lastCtx = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && typeof m.context_tokens === 'number');
    set({
      activeSessionId: sessionId,
      turns,
      trace,
      contextUsage:
        lastCtx?.context_tokens !== undefined
          ? { promptTokens: lastCtx.context_tokens, contextWindow: lastCtx.context_window ?? 0 }
          : null,
      liveContext: null,
      liveItems: [],
      liveFrames: {},
      frameStack: ['root'],
      liveReasoning: '',
      streaming: false,
      pendingAsk: null,
      lastTurnTruncated: false,
      turnTraceStart: trace.length,
    });
  },

  clearActive: () =>
    set({
      activeSessionId: null,
      turns: [],
      trace: [],
      contextUsage: null,
      liveContext: null,
      liveItems: [],
      liveFrames: {},
      frameStack: ['root'],
      liveReasoning: '',
      streaming: false,
      pendingAsk: null,
      lastTurnTruncated: false,
      turnTraceStart: 0,
    }),

  send: (agentName, content, sessionId, images) => {
    get().wire();
    const history = turnsToHistory(get().turns);
    const imgs = images?.length ? images : undefined;
    set((s) => ({
      activeSessionId: sessionId,
      turns: [...s.turns, { role: 'user', blocks: [{ kind: 'text', text: content }], images: imgs }],
      liveItems: [],
      // Seed the root frame so top-level stream chunks have a home before any hop occurs.
      liveFrames: {
        root: {
          id: 'root',
          agent: agentName,
          from: '',
          depth: 0,
          query: content,
          status: 'running',
          startedAt: Date.now(),
        },
      },
      frameStack: ['root'],
      liveReasoning: '',
      streaming: true,
      pendingAsk: null,
      lastTurnTruncated: false,
      turnTraceStart: s.trace.length,
      workingSessions: s.workingSessions.includes(sessionId)
        ? s.workingSessions
        : [...s.workingSessions, sessionId],
      workingAgents: bumpAgent(s.workingAgents, agentName, +1),
      sessionAgent: { ...s.sessionAgent, [sessionId]: agentName },
    }));

    void sessionsApi.addMessage(sessionId, { role: 'user', text: content, images: imgs }).catch(() => {});
    getSocket().emit('chat:message', {
      agentName,
      content,
      sessionId,
      history,
      images: imgs?.map((dataUrl) => ({ dataUrl })),
    });
  },

  stop: () => {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    // Fire-and-forget: the backend aborts the run and emits `chat:done`, which resolves the live
    // buffer into a (partial) turn through the normal path. Any pending `ask_user` is cleared too.
    getSocket().emit('chat:stop', { sessionId });
    set({ pendingAsk: null });
  },

  answerAsk: (answer) => {
    const pending = get().pendingAsk;
    if (!pending) return;
    getSocket().emit('ask_user:response', { requestId: pending.requestId, answer });
    set({ pendingAsk: null });
  },
}));
