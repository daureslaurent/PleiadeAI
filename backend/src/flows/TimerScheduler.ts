import { createLogger } from '../config/logger';
import { flowRepository } from '../domain/flows/flow.repository';
import type { FlowDoc, FlowNode } from '../domain/flows/flow.model';
import { streamRegistry } from '../streaming/StreamRegistry';

const log = createLogger('flow:timer');

/** Floor on the tick interval. Below this a render can never keep up and the queue just thrashes. */
export const MIN_INTERVAL_SECONDS = 5;
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_FAILURES = 5;

interface ArmedTimer {
  timer: NodeJS.Timeout;
  intervalMs: number;
  /** Set while a tick's run is in flight, so the next tick can skip rather than overlap. */
  running: boolean;
  consecutiveFailures: number;
}

/**
 * Sub-minute re-firing of whole flows (STREAMING_PLAN.md §4).
 *
 * Agenda already schedules flows, and everything cron-shaped should keep going through it — but its
 * granularity is a minute and a generative stream ticks in seconds, so the Time trigger gets its own
 * in-process timers. The armed state is persisted on the flow (`timer_armed`) rather than held only
 * in memory, so a backend restart brings the radios back on air by itself.
 *
 * Two rules keep it from running away: a tick that lands while the previous run is still going is
 * **skipped**, and a run of consecutive failures disarms the timer instead of ticking forever.
 */
export class FlowTimerScheduler {
  private readonly armed = new Map<string, ArmedTimer>();

  /** Re-arm every flow that was armed when the process stopped. Called once at boot. */
  async restore(): Promise<void> {
    const flows = await flowRepository.list().catch(() => [] as FlowDoc[]);
    const pending = flows.filter((f) => (f as FlowDoc & { timer_armed?: boolean }).timer_armed);
    for (const flow of pending) {
      await this.arm(String(flow._id), { persist: false }).catch((err) =>
        log.error({ err, flow: flow.name }, 'failed to restore a flow timer'),
      );
    }
    if (pending.length > 0) log.info({ count: pending.length }, 'flow timers restored');
  }

  isArmed(flowId: string): boolean {
    return this.armed.has(flowId);
  }

  /** Flow ids with a live timer. */
  list(): string[] {
    return [...this.armed.keys()];
  }

  /**
   * Arm (or re-arm, picking up a changed interval) a flow's timer. Idempotent: arming an
   * already-armed flow with the same interval leaves the running countdown alone, so a node that
   * auto-arms on every run does not keep resetting the clock.
   */
  async arm(flowId: string, opts: { persist?: boolean } = {}): Promise<void> {
    const flow = await flowRepository.findById(flowId);
    if (!flow) throw new Error('flow not found');

    const node = timerNodeOf(flow);
    if (!node) throw new Error('this flow has no Time node to arm');

    const intervalMs = intervalOf(node) * 1000;
    const existing = this.armed.get(flowId);
    if (existing && existing.intervalMs === intervalMs) {
      if (opts.persist) await this.persist(flowId, true);
      return;
    }
    if (existing) clearInterval(existing.timer);

    const entry: ArmedTimer = {
      timer: setInterval(() => void this.tick(flowId), intervalMs),
      intervalMs,
      running: false,
      consecutiveFailures: 0,
    };
    entry.timer.unref?.();
    this.armed.set(flowId, entry);
    if (opts.persist !== false) await this.persist(flowId, true);
    log.info({ flow: flow.name, everySeconds: intervalMs / 1000 }, 'flow timer armed');
  }

  /** Disarm a flow's timer. Leaves any live stream alone — stopping a stream is a separate act. */
  async disarm(flowId: string, opts: { persist?: boolean } = {}): Promise<boolean> {
    const entry = this.armed.get(flowId);
    if (entry) clearInterval(entry.timer);
    this.armed.delete(flowId);
    if (opts.persist !== false) await this.persist(flowId, false);
    return Boolean(entry);
  }

  async stopAll(): Promise<void> {
    // In-memory only: the persisted `timer_armed` flag is deliberately left set so a restart
    // resumes the streams rather than silently ending them.
    for (const entry of this.armed.values()) clearInterval(entry.timer);
    this.armed.clear();
  }

  private async persist(flowId: string, armed: boolean): Promise<void> {
    await flowRepository
      .update(flowId, { timer_armed: armed } as Partial<FlowDoc>)
      .catch((err) => log.error({ err, flowId }, 'failed to persist the flow timer state'));
  }

  private async tick(flowId: string): Promise<void> {
    const entry = this.armed.get(flowId);
    if (!entry) return;
    if (entry.running) {
      log.debug({ flowId }, 'timer tick skipped — the previous run is still going');
      return;
    }

    const flow = await flowRepository.findById(flowId).catch(() => null);
    if (!flow) {
      log.warn({ flowId }, 'timer disarmed — the flow no longer exists');
      await this.disarm(flowId);
      return;
    }
    if (!flow.enabled) {
      log.info({ flow: flow.name }, 'timer tick skipped — the flow is disabled');
      return;
    }

    entry.running = true;
    try {
      // Imported here rather than at module load: `FlowRunner` pulls in the node registry, which
      // pulls in the Time node, which needs this scheduler — a cycle at import time.
      const { flowRunner } = await import('./FlowRunner');
      const outcome = await flowRunner.start({ flow, trigger: 'timer' });
      if (outcome.status === 'success') entry.consecutiveFailures = 0;
      else {
        entry.consecutiveFailures += 1;
        log.warn(
          { flow: flow.name, failures: entry.consecutiveFailures, error: outcome.error },
          'a timed flow run failed',
        );
      }
    } catch (err) {
      entry.consecutiveFailures += 1;
      log.error({ err, flow: flow.name }, 'a timed flow run threw');
    } finally {
      entry.running = false;
    }

    const limit = maxFailuresOf(timerNodeOf(flow));
    if (entry.consecutiveFailures >= limit) {
      log.error({ flow: flow.name, failures: entry.consecutiveFailures }, 'timer disarmed after repeated failures');
      await this.disarm(flowId);
      // Nothing will feed the stream now, so let it go rather than loop its last clip until the
      // idle timeout: a disarmed radio is off the air.
      await streamRegistry.stop(flowId).catch(() => undefined);
    }
  }
}

function timerNodeOf(flow: FlowDoc): FlowNode | undefined {
  return ((flow.nodes ?? []) as FlowNode[]).find((n) => n.type === 'timer');
}

function intervalOf(node: FlowNode): number {
  const raw = Number(node.config?.interval_seconds);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_SECONDS;
  return Math.max(MIN_INTERVAL_SECONDS, seconds);
}

function maxFailuresOf(node: FlowNode | undefined): number {
  const raw = Number(node?.config?.max_failures);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FAILURES;
}

export const flowTimerScheduler = new FlowTimerScheduler();
