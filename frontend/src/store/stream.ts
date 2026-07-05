import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { sessionsApi, type StoredMessage } from '../lib/api';
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
} from '../lib/ws-events.types';

/** Session context size shown in the chat header (prompt tokens vs the model's context window). */
export interface ContextUsage {
  promptTokens: number;
  contextWindow: number;
}

/** Ordered pieces of an assistant turn: prose interleaved with inline tool blocks. */
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
        children: buildBlocks(it.refFrameId, items, frames),
      });
    }
  }
  return out;
}

export type Turn =
  | { role: 'user'; blocks: [{ kind: 'text'; text: string }] }
  | { role: 'assistant'; blocks: Block[] };

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
  /** Latest reported context size for the active session (null until the first turn completes). */
  contextUsage: ContextUsage | null;
  /** An agent is blocking on `ask_user`; drives the operator prompt modal. Null when nothing waits. */
  pendingAsk: { requestId: string; agent: string; question: string } | null;
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
  send: (agentName: string, content: string, sessionId: string) => void;
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
  pendingAsk: null,
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

    socket.on('tool_end', (e: ToolEndEvent) => {
      set((s) => ({
        liveItems: s.liveItems.map((it) =>
          it.kind === 'tool' && it.callId === e.callId
            ? { ...it, status: e.status, result: e.result, output: it.output || resultToOutput(e.result) }
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

    socket.on('context_usage', (e: ContextUsageEvent) => {
      // Only reflect the on-screen session; background runs update their own persisted messages.
      if (e.sessionId !== get().activeSessionId) return;
      if (e.depth === 0) {
        // The user-facing agent: drives the session header meter.
        set({ contextUsage: { promptTokens: e.promptTokens, contextWindow: e.contextWindow } });
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

    // A run is still in flight for a session we just re-opened (e.g. the user refreshed mid-turn).
    // Reflect the working state so the UI doesn't look stopped; the terminal `chat:done` (broadcast
    // to the room) will resolve it.
    socket.on('chat:running', ({ sessionId }: { sessionId: string }) => {
      set((s) =>
        sessionId === s.activeSessionId
          ? {
              streaming: true,
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
      }: {
        sessionId: string;
        answer: string;
        persisted?: boolean;
        /** Rich blocks the backend assembled when it persisted the turn itself (client was gone). */
        blocks?: Block[];
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

        set({
          ...shared,
          streaming: false,
          turns: hasContent ? [...s.turns, { role: 'assistant', blocks }] : s.turns,
          liveItems: [],
          liveFrames: {},
          frameStack: ['root'],
          liveReasoning: '',
          trace,
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
              context_tokens: s.contextUsage?.promptTokens,
              context_window: s.contextUsage?.contextWindow,
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
        ? { role: 'user', blocks: [{ kind: 'text', text: m.text }] }
        : { role: 'assistant', blocks: (m.blocks as Block[] | undefined) ?? [{ kind: 'text', text: m.text }] },
    );
    const trace: TraceEntry[] = messages.flatMap((m) => (m.trace as TraceEntry[] | undefined) ?? []);
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
      liveItems: [],
      liveFrames: {},
      frameStack: ['root'],
      liveReasoning: '',
      streaming: false,
      pendingAsk: null,
      turnTraceStart: trace.length,
    });
  },

  clearActive: () =>
    set({
      activeSessionId: null,
      turns: [],
      trace: [],
      contextUsage: null,
      liveItems: [],
      liveFrames: {},
      frameStack: ['root'],
      liveReasoning: '',
      streaming: false,
      pendingAsk: null,
      turnTraceStart: 0,
    }),

  send: (agentName, content, sessionId) => {
    get().wire();
    const history = turnsToHistory(get().turns);
    set((s) => ({
      activeSessionId: sessionId,
      turns: [...s.turns, { role: 'user', blocks: [{ kind: 'text', text: content }] }],
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
      turnTraceStart: s.trace.length,
      workingSessions: s.workingSessions.includes(sessionId)
        ? s.workingSessions
        : [...s.workingSessions, sessionId],
      workingAgents: bumpAgent(s.workingAgents, agentName, +1),
      sessionAgent: { ...s.sessionAgent, [sessionId]: agentName },
    }));

    void sessionsApi.addMessage(sessionId, { role: 'user', text: content }).catch(() => {});
    getSocket().emit('chat:message', { agentName, content, sessionId, history });
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
