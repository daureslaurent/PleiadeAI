import { AsyncLocalStorage } from 'node:async_hooks';
import type { LlamaCallSource } from '../core/event-bus/events.types';

/**
 * Ambient capture context for the LLM Debug feature (spec: LLM Debug page).
 *
 * Every HTTP call to the inference server is captured centrally inside {@link LlamaClient}, but the
 * linkage that makes a capture useful for debugging (and later fine-tuning export) — which session,
 * agent, and hop depth it belongs to, and what kind of call it is — lives in the *caller*, spread
 * across the orchestrator, tools, and domain services. Rather than thread a context argument through
 * every `streamChat`/`complete` signature, callers wrap their call in {@link runWithCaptureContext}
 * and `LlamaClient` reads it via {@link getCaptureContext}. `AsyncLocalStorage` propagates the store
 * across awaits, so the value is still present deep inside the streamed inference loop.
 *
 * Absent context (no wrapping caller) is fine — the capture just records `source: 'chat-turn'` with
 * null linkage. Side tasks always set at least a `source`.
 */
export interface CaptureContext {
  sessionId?: string;
  agentId?: string;
  agentName?: string;
  /** Cross-agent hop depth (0 = directly addressed agent). */
  depth?: number;
  source: LlamaCallSource;
}

const storage = new AsyncLocalStorage<CaptureContext>();

/** Run `fn` with the given capture context bound for any llama call it makes (across awaits). */
export function runWithCaptureContext<T>(cc: CaptureContext, fn: () => T): T {
  return storage.run(cc, fn);
}

/** The capture context bound by the nearest enclosing {@link runWithCaptureContext}, if any. */
export function getCaptureContext(): CaptureContext | undefined {
  return storage.getStore();
}
