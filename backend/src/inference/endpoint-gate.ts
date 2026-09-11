import { createLogger } from '../config/logger';
import type { LlamaCallSource } from '../core/event-bus/events.types';
import { getCaptureContext } from './capture-context';
import type { TokenUsage } from './LlamaClient';

const log = createLogger('endpoint-gate');

/**
 * Meters inference calls per endpoint and records live call metrics.
 *
 * A remote `llama.cpp` server processes one request per **slot**, and how many slots it has is a
 * property of how it was launched (`--parallel` / `-np`). The gate therefore admits up to that many
 * concurrent calls per URL and queues the rest (FIFO). The limit is the endpoint's
 * `parallel_slots`, carried on every `ResolvedInference` so no caller has to look an endpoint up
 * mid-stream; an endpoint that never declares one stays at 1, which is exactly the strict
 * serialization this gate did before slots existed.
 *
 * Over-declaring is the failure to avoid: llama.cpp will accept the extra requests and queue them
 * *inside* the server, where this app can neither see nor meter them, and each in-flight request
 * costs its own slice of the shared KV cache.
 *
 * Different endpoints run fully independently (permits are keyed by normalized base URL), so the
 * CPU embeddings box and the GPU chat box never block each other.
 *
 * The gate is also the single source of truth for the LLM activity page: it tallies calls, errors,
 * tokens and durations per endpoint and per model, plus the live active/queued depth.
 */

/** Identity of one call passing through the gate — who is (or will be) talking to the endpoint. */
export interface GateCall {
  model: string;
  /** Agent making the call (null for side tasks with no agent, e.g. the interviewer). */
  agentName: string | null;
  /** What kind of call it is (chat-turn, title-gen, vision, …) from the capture context. */
  source: LlamaCallSource;
  /** When the call entered the gate (queuedAt) / took the lock (startedAt). */
  at: number;
}

/** Rolling counters for one model served by an endpoint. */
export interface ModelStat {
  model: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
  lastCallAt: number | null;
}

/** Rolling counters for one endpoint URL, with a per-model breakdown. */
export interface EndpointStat {
  /** Normalized base URL (trailing slash stripped) — the metrics key. */
  url: string;
  /** Calls currently streaming — up to the endpoint's `parallel_slots`. */
  active: number;
  /** Calls parked waiting for a slot. */
  queued: number;
  /** How many concurrent calls this URL is admitting, as last declared by a caller. */
  slots: number;
  /** The calls holding a slot right now (`at` = when each started streaming). Empty when idle. */
  running: GateCall[];
  /** Calls parked behind `running`, FIFO (`at` = when each entered the queue). */
  waiting: GateCall[];
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalDurationMs: number;
  lastCallAt: number | null;
  lastModel: string | null;
  models: Map<string, ModelStat>;
}

/** Handle returned by {@link EndpointGate.acquire}; exactly one terminal call releases the lock. */
export interface CallHandle {
  /** Report a completed call (with usage when the server sent it) and release the lock. */
  success: (usage?: TokenUsage | null) => void;
  /** Report a failed call and release the lock. */
  fail: () => void;
}

const norm = (url: string): string => url.replace(/\/$/, '');

/** One caller parked waiting for a slot, in arrival order. */
interface Waiter {
  entry: GateCall;
  admit: () => void;
}

class EndpointGate {
  /** FIFO of callers parked on each URL, oldest first. */
  private queues = new Map<string, Waiter[]>();
  private stats = new Map<string, EndpointStat>();

  private stat(url: string): EndpointStat {
    let s = this.stats.get(url);
    if (!s) {
      s = {
        url,
        active: 0,
        queued: 0,
        slots: 1,
        running: [],
        waiting: [],
        calls: 0,
        errors: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalDurationMs: 0,
        lastCallAt: null,
        lastModel: null,
        models: new Map(),
      };
      this.stats.set(url, s);
    }
    return s;
  }

  private modelStat(s: EndpointStat, model: string): ModelStat {
    let m = s.models.get(model);
    if (!m) {
      m = { model, calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, totalDurationMs: 0, lastCallAt: null };
      s.models.set(model, m);
    }
    return m;
  }

  /**
   * Admit as many parked callers as there are free slots, oldest first. Called after every release
   * and on arrival. The limit is re-read from the stat each time, so an operator lowering
   * `parallel_slots` while calls are in flight simply stops admitting until the extra ones drain —
   * no permit is stranded and no in-flight stream is cut short.
   */
  private pump(url: string): void {
    const s = this.stat(url);
    const queue = this.queues.get(url);
    if (!queue?.length) return;
    // `active` is the count, incremented HERE rather than derived from `running.length`. Resolving a
    // promise only schedules its continuation, so an admitted caller has not yet pushed itself onto
    // `running` when the next `acquire` of the same tick pumps — counting the list would admit every
    // caller in that tick and hand a one-slot endpoint four concurrent streams.
    while (queue.length && s.active < Math.max(1, s.slots)) {
      const next = queue.shift();
      if (!next) break;
      s.queued--;
      s.waiting.splice(s.waiting.indexOf(next.entry), 1);
      s.active++;
      next.admit();
    }
  }

  /**
   * Wait for a slot on `url`, then return a handle. The caller MUST call exactly one of
   * `success`/`fail` (in a `finally`) to release it — otherwise that slot is gone for the life of
   * the process. Resolves immediately when the endpoint has a slot free.
   *
   * @param slots How many concurrent calls this endpoint serves (`parallel_slots`, default 1).
   *              Carried on `ResolvedInference`, so the newest resolution wins for the whole URL —
   *              which is what makes a settings change take effect without a restart.
   */
  async acquire(rawUrl: string, model: string, slots = 1): Promise<CallHandle> {
    const url = norm(rawUrl);
    const s = this.stat(url);
    s.slots = Math.max(1, Math.floor(slots) || 1);
    // Who this call is for — read here (not after we park) so the queue entry is identified the
    // moment it queues. AsyncLocalStorage carries the caller's session/agent/source.
    const cc = getCaptureContext();
    const entry: GateCall = {
      model,
      agentName: cc?.agentName ?? null,
      source: cc?.source ?? 'chat-turn',
      at: Date.now(),
    };

    // Always join the queue, even when a slot is free: going through `pump` is what keeps admission
    // strictly FIFO. Jumping straight in when `running.length < slots` would let a call that arrived
    // late overtake one parked since before the slot opened.
    const queue = this.queues.get(url) ?? [];
    if (!this.queues.has(url)) this.queues.set(url, queue);
    s.queued++;
    s.waiting.push(entry);
    await new Promise<void>((admit) => {
      queue.push({ entry, admit });
      this.pump(url);
    });

    const started = Date.now();
    const running: GateCall = { ...entry, at: started };
    s.running.push(running);

    let done = false;
    const finish = (usage: TokenUsage | null | undefined, ok: boolean): void => {
      if (done) return;
      done = true;
      const i = s.running.indexOf(running);
      if (i >= 0) s.running.splice(i, 1);
      s.active = Math.max(0, s.active - 1);
      s.calls++;
      s.lastCallAt = Date.now();
      s.lastModel = model;
      const ms = this.modelStat(s, model);
      ms.calls++;
      ms.lastCallAt = s.lastCallAt;
      const dur = Date.now() - started;
      s.totalDurationMs += dur;
      ms.totalDurationMs += dur;
      if (!ok) {
        s.errors++;
        ms.errors++;
      }
      if (usage) {
        s.promptTokens += usage.promptTokens;
        s.completionTokens += usage.completionTokens;
        ms.promptTokens += usage.promptTokens;
        ms.completionTokens += usage.completionTokens;
      }
      // Hand the freed slot to whoever has been waiting longest.
      this.pump(url);
    };

    if (s.queued > 0) {
      log.debug({ url, queued: s.queued, slots: s.slots }, 'every slot busy — call queued behind others');
    }

    return {
      success: (usage) => finish(usage, true),
      fail: () => finish(undefined, false),
    };
  }

  /** Immutable snapshot of every endpoint seen so far, for the metrics API. */
  snapshot(): EndpointStat[] {
    return [...this.stats.values()].map((s) => ({
      ...s,
      running: [...s.running],
      waiting: [...s.waiting],
      models: new Map(s.models),
    }));
  }
}

export const endpointGate = new EndpointGate();
