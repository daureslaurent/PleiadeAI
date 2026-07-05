import { randomUUID } from 'node:crypto';
import { createLogger } from '../../config/logger';
import { eventBus } from '../../core/event-bus/EventBus';
import type { EventContext } from '../../core/event-bus/events.types';

const log = createLogger('ask-user');

/** How long a blocked `ask_user` waits for the operator before giving up. */
const ASK_USER_TIMEOUT_MS = 15 * 60 * 1000;

interface Pending {
  sessionId: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Bridges a blocking `ask_user` tool call to the human operator over the WebSocket. `ask` emits a
 * `agent:ask_user` event (relayed by the bridge to the session's room as a modal) and returns a
 * promise that stays pending until the client replies (`resolve`), the request times out, or the
 * session ends (`cancelSession`). Single-operator, so an in-memory map is sufficient.
 */
class AskUserBroker {
  private readonly pending = new Map<string, Pending>();

  ask(ctx: EventContext, question: string): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('the operator did not answer in time'));
      }, ASK_USER_TIMEOUT_MS);
      this.pending.set(requestId, { sessionId: ctx.sessionId, resolve, reject, timer });
      eventBus.emit('agent:ask_user', { ctx, requestId, question });
    });
  }

  /** Deliver the operator's answer; no-op if the request already timed out / was cancelled. */
  resolve(requestId: string, answer: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(answer);
  }

  /** Reject every pending question for a session whose client went away. */
  cancelSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error('session ended before the operator answered'));
      log.debug({ requestId: id, sessionId }, 'ask_user cancelled');
    }
  }
}

export const askUserBroker = new AskUserBroker();
