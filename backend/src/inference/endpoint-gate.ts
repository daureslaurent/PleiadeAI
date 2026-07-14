import { createLogger } from '../config/logger';
import type { LlamaCallSource } from '../core/event-bus/events.types';
import { getCaptureContext } from './capture-context';
import type { TokenUsage } from './LlamaClient';

const log = createLogger('endpoint-gate');

/**
 * Serializes inference calls per endpoint and records live call metrics.
 *
 * A remote `llama.cpp` server (and most single-GPU OpenAI-compatible backends) processes one
 * request per slot; firing several streamed turns at the same box in parallel just thrashes it.
 * Every chat inference therefore passes through {@link EndpointGate.acquire}, which grants the URL's
 * lock to one caller at a time — the rest queue (FIFO) and stream only once their turn comes up.
 * Different endpoints run fully independently (the lock is keyed by normalized base URL), so the
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
  /** Calls currently streaming (0 or 1 while the gate holds the lock). */
  active: number;
  /** Calls parked waiting for the lock. */
  queued: number;
  /** The call holding the lock right now (`at` = when it started streaming), or null when idle. */
  current: GateCall | null;
  /** Calls parked behind `current`, FIFO (`at` = when each entered the queue). */
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

class EndpointGate {
  /** Tail of the per-URL promise chain; awaiting it is "wait for everyone ahead of me". */
  private tails = new Map<string, Promise<void>>();
  private stats = new Map<string, EndpointStat>();

  private stat(url: string): EndpointStat {
    let s = this.stats.get(url);
    if (!s) {
      s = {
        url,
        active: 0,
        queued: 0,
        current: null,
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
   * Wait for exclusive access to `url`, then return a handle. The caller MUST call exactly one of
   * `success`/`fail` (in a `finally`) to release the lock — otherwise every later call to the same
   * endpoint deadlocks. Resolves immediately when the endpoint is idle.
   */
  async acquire(rawUrl: string, model: string): Promise<CallHandle> {
    const url = norm(rawUrl);
    const s = this.stat(url);
    // Who this call is for — read here (not after `await prev`) so the queue entry is identified
    // the moment it parks. AsyncLocalStorage carries the caller's session/agent/source.
    const cc = getCaptureContext();
    const entry: GateCall = {
      model,
      agentName: cc?.agentName ?? null,
      source: cc?.source ?? 'chat-turn',
      at: Date.now(),
    };

    const prev = this.tails.get(url) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Everyone after us waits on `gate`; we wait on `prev`. The map always holds just the latest
    // tail, so it never grows past one entry per endpoint.
    this.tails.set(
      url,
      prev.then(() => gate),
    );

    s.queued++;
    s.waiting.push(entry);
    await prev;
    s.queued--;
    s.waiting.splice(s.waiting.indexOf(entry), 1);
    s.active++;
    const started = Date.now();
    s.current = { ...entry, at: started };

    let done = false;
    const finish = (usage: TokenUsage | null | undefined, ok: boolean): void => {
      if (done) return;
      done = true;
      s.active--;
      s.current = null;
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
      release();
    };

    if (s.queued > 0) log.debug({ url, queued: s.queued }, 'endpoint busy — call queued behind others');

    return {
      success: (usage) => finish(usage, true),
      fail: () => finish(undefined, false),
    };
  }

  /** Immutable snapshot of every endpoint seen so far, for the metrics API. */
  snapshot(): EndpointStat[] {
    return [...this.stats.values()].map((s) => ({
      ...s,
      waiting: [...s.waiting],
      models: new Map(s.models),
    }));
  }
}

export const endpointGate = new EndpointGate();
