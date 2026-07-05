import { EventEmitter } from 'node:events';
import { createLogger } from '../../config/logger';

const log = createLogger('session-lock');

/**
 * In-process registry of active *user* sessions, keyed by agent id.
 *
 * Concurrency rule (spec §5): if an Agenda cron job fires for an agent that a user is
 * actively chatting with, the user takes absolute priority and the background task waits
 * until the live session naturally resolves. Because the backend is a single stateless
 * process with one in-process EventBus, an in-memory counter is authoritative — no external
 * lock store is required.
 *
 * A counter (not a boolean) tolerates overlapping tabs/turns on the same agent: the agent
 * is "free" only when every user session has released.
 */
class SessionLock {
  private readonly active = new Map<string, number>();
  private readonly signals = new EventEmitter();

  constructor() {
    this.signals.setMaxListeners(0); // unbounded: cron waiters may queue up
  }

  /** Register the start of a live user session for `agentId`. */
  acquireUserSession(agentId: string): void {
    const next = (this.active.get(agentId) ?? 0) + 1;
    this.active.set(agentId, next);
    log.debug({ agentId, active: next }, 'user session acquired');
  }

  /** Mark a live user session as ended; wakes any cron jobs waiting on this agent. */
  releaseUserSession(agentId: string): void {
    const current = this.active.get(agentId) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this.active.delete(agentId);
      this.signals.emit(this.channel(agentId));
    } else {
      this.active.set(agentId, next);
    }
    log.debug({ agentId, active: next }, 'user session released');
  }

  /** True while at least one user session is live for `agentId`. */
  isUserActive(agentId: string): boolean {
    return (this.active.get(agentId) ?? 0) > 0;
  }

  /**
   * Resolve once no user session is active for `agentId`. A cron job calls this before
   * running so it yields to the user. Returns immediately if already free.
   *
   * @param timeoutMs Optional cap; resolves `false` if the agent stays busy past it,
   *                  letting the caller re-queue the job instead of blocking forever.
   */
  waitUntilFree(agentId: string, timeoutMs?: number): Promise<boolean> {
    if (!this.isUserActive(agentId)) return Promise.resolve(true);

    log.info({ agentId }, 'cron yielding to active user session');
    return new Promise((resolve) => {
      const channel = this.channel(agentId);
      let timer: NodeJS.Timeout | undefined;

      const onFree = (): void => {
        if (timer) clearTimeout(timer);
        this.signals.off(channel, onFree);
        resolve(true);
      };

      this.signals.on(channel, onFree);

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.signals.off(channel, onFree);
          log.warn({ agentId, timeoutMs }, 'cron wait timed out; agent still busy');
          resolve(false);
        }, timeoutMs);
      }
    });
  }

  private channel(agentId: string): string {
    return `free:${agentId}`;
  }
}

/** Process-wide singleton. */
export const sessionLock = new SessionLock();
