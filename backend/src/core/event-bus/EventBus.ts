import { EventEmitter } from 'node:events';
import { createLogger } from '../../config/logger';
import type { EventMap, EventName } from './events.types';

const log = createLogger('event-bus');

/**
 * Strongly-typed wrapper over Node's native EventEmitter.
 *
 * `emit`/`on`/`once`/`off` are constrained by `EventMap`, so an event name always carries
 * exactly its declared payload — mismatches are compile errors, not runtime surprises.
 * This is the single in-process router for the whole backend (no Redis/RabbitMQ): agent
 * runs, tool invocations, cross-agent hops, and alerts all flow through one instance.
 */
export class TypedEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Agent runs can legitimately attach many transient listeners (per session/hop).
    // Raise the ceiling so Node's leak warning doesn't fire during normal fan-out.
    this.emitter.setMaxListeners(100);
  }

  emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    if (log.isLevelEnabled('trace')) {
      log.trace({ event }, 'emit');
    }
    this.emitter.emit(event, payload);
  }

  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): this {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return this;
  }

  once<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): this {
    this.emitter.once(event, listener as (payload: unknown) => void);
    return this;
  }

  off<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): this {
    this.emitter.off(event, listener as (payload: unknown) => void);
    return this;
  }

  /**
   * Await the next occurrence of `event`, optionally filtered. Useful for request/response
   * style flows (e.g. waiting for a specific tool completion) without leaking listeners.
   */
  waitFor<E extends EventName>(
    event: E,
    predicate?: (payload: EventMap[E]) => boolean,
  ): Promise<EventMap[E]> {
    return new Promise((resolve) => {
      const handler = (payload: EventMap[E]): void => {
        if (predicate && !predicate(payload)) return;
        this.off(event, handler);
        resolve(payload);
      };
      this.on(event, handler);
    });
  }

  removeAllListeners(event?: EventName): void {
    this.emitter.removeAllListeners(event);
  }
}

/** Process-wide singleton bus. Import this everywhere routing is needed. */
export const eventBus = new TypedEventBus();
