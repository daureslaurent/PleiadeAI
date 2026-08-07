import { createLogger } from '../config/logger';
import { StreamBuffer } from './StreamBuffer';
import type { StreamInfo, StreamProfile } from './types';

const log = createLogger('stream:registry');

/** How often idle streams are swept. Coarse on purpose — the timeout itself is in minutes. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Every live stream, keyed by **flow id** (STREAMING_PLAN.md §2).
 *
 * One flow means one stream, for as long as the operator keeps feeding it. That single choice is
 * what lets a prompt be edited and the flow re-run without the listener noticing: the run that
 * produced the clip is irrelevant to the stream's identity, so a new run just pushes into the
 * buffer that is already on air.
 */
export class StreamRegistry {
  private readonly streams = new Map<string, StreamBuffer>();
  private sweeper: NodeJS.Timeout | null = null;

  /** Fetch the stream for a flow, or open one with the given profile. */
  getOrCreate(flowId: string, flowName: string, profile: StreamProfile): StreamBuffer {
    const existing = this.streams.get(flowId);
    if (existing) {
      // The name can drift when a flow is renamed mid-stream; the profile deliberately cannot —
      // changing resolution or codec on a live flux would break every attached decoder.
      existing.flowName = flowName;
      return existing;
    }
    const stream = new StreamBuffer(flowId, flowName, profile);
    this.streams.set(flowId, stream);
    this.startSweeper();
    log.info({ flowId, flow: flowName, kind: profile.kind }, 'stream opened');
    return stream;
  }

  get(flowId: string): StreamBuffer | undefined {
    return this.streams.get(flowId);
  }

  list(): StreamInfo[] {
    return [...this.streams.values()].map((s) => s.info());
  }

  async stop(flowId: string): Promise<boolean> {
    const stream = this.streams.get(flowId);
    if (!stream) return false;
    this.streams.delete(flowId);
    await stream.stop();
    return true;
  }

  async stopAll(): Promise<void> {
    const all = [...this.streams.values()];
    this.streams.clear();
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    await Promise.all(all.map((s) => s.stop()));
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [flowId, stream] of this.streams) {
        if (!stream.isIdle(now)) continue;
        log.info({ flowId, flow: stream.flowName }, 'stream idle — tearing down');
        this.streams.delete(flowId);
        void stream.stop().catch(() => undefined);
      }
      if (this.streams.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }
}

export const streamRegistry = new StreamRegistry();
