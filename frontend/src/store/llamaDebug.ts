import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { llmDebugApi, type LlamaCallRecord } from '../lib/api';
import type {
  LlamaCallStartEvent,
  LlamaCallDeltaEvent,
  LlamaCallEndEvent,
} from '../lib/ws-events.types';

/**
 * Live-streaming LLM Debug feed. Mirrors the `stream.ts` pattern: `wire()` installs the socket
 * subscriptions once and joins the global `llama-log` room; `hydrate()` loads the persisted records.
 *
 * An in-flight call lives in `live` (keyed by id) accumulating its streamed response text. When it
 * ends we drop it from `live` and refetch the persisted list — the completed call then reappears from
 * Mongo (the durable source of truth), so a page refresh shows the exact same rows.
 */
export interface LiveCall {
  id: string;
  source: LlamaCallStartEvent['source'];
  agent: string | null;
  model: string;
  endpoint: string;
  request: LlamaCallStartEvent['request'];
  /** Response text streamed so far. */
  text: string;
  startedAt: number;
}

interface LlamaDebugState {
  records: LlamaCallRecord[];
  live: Record<string, LiveCall>;
  /** How many records to list; ≤50 hits the fast capped buffer, larger pages the archive. */
  limit: number;
  loading: boolean;
  error: boolean;
  wired: boolean;
  wire: () => void;
  hydrate: () => Promise<void>;
  setLimit: (limit: number) => void;
}

export const useLlamaDebug = create<LlamaDebugState>((set, get) => ({
  records: [],
  live: {},
  limit: 10,
  loading: true,
  error: false,
  wired: false,

  wire: () => {
    if (get().wired) return;
    const socket = getSocket();
    socket.emit('llama:subscribe');
    // Re-join the room after a reconnect (socket.io drops room membership on disconnect).
    socket.on('connect', () => socket.emit('llama:subscribe'));

    socket.on('llama_call_start', (e: LlamaCallStartEvent) => {
      set((s) => ({
        live: {
          ...s.live,
          [e.id]: {
            id: e.id,
            source: e.source,
            agent: e.agent,
            model: e.model,
            endpoint: e.endpoint,
            request: e.request,
            text: '',
            startedAt: e.at,
          },
        },
      }));
    });

    socket.on('llama_call_delta', (e: LlamaCallDeltaEvent) => {
      set((s) => {
        const call = s.live[e.id];
        if (!call) return s;
        return { live: { ...s.live, [e.id]: { ...call, text: call.text + e.delta } } };
      });
    });

    socket.on('llama_call_end', (_e: LlamaCallEndEvent) => {
      // Drop the live entry; the completed call is now persisted — refetch so it shows from Mongo.
      set((s) => {
        const next = { ...s.live };
        delete next[_e.id];
        return { live: next };
      });
      void get().hydrate();
    });

    set({ wired: true });
  },

  hydrate: async () => {
    try {
      const records = await llmDebugApi.list(get().limit);
      set({ records, loading: false, error: false });
    } catch {
      set({ loading: false, error: true });
    }
  },

  setLimit: (limit) => {
    set({ limit, loading: true });
    void get().hydrate();
  },
}));
