import { create } from 'zustand';
import { getSocket } from '../lib/socket';
import { finetuneJobsApi, type FinetuneJob } from '../lib/api';
import type { FinetuneJobUpdateEvent } from '../lib/ws-events.types';

/**
 * Live fine-tune job feed. Mirrors `llamaDebug.ts`: `wire()` installs the socket subscription once
 * and joins the global `finetune` room; `hydrate()` loads the durable jobs from Mongo.
 *
 * The backend poller pushes only the metric datapoints observed since its last tick, so an update
 * *appends* to the job's loss curve rather than replacing it — the curve stays smooth without
 * refetching a potentially long series on every tick. Terminal transitions trigger one `hydrate()`
 * so the final record (gguf filename, finished_at) comes from the durable source of truth.
 */
interface FinetuneState {
  jobs: FinetuneJob[];
  loading: boolean;
  error: boolean;
  wired: boolean;
  wire: () => void;
  hydrate: () => Promise<void>;
}

export const useFinetune = create<FinetuneState>((set, get) => ({
  jobs: [],
  loading: true,
  error: false,
  wired: false,

  wire: () => {
    if (get().wired) return;
    const socket = getSocket();
    socket.emit('finetune:subscribe');
    // Re-join the room after a reconnect (socket.io drops room membership on disconnect).
    socket.on('connect', () => socket.emit('finetune:subscribe'));

    socket.on('finetune_job_update', (e: FinetuneJobUpdateEvent) => {
      const wasTerminal = e.status === 'done' || e.status === 'failed';
      set((s) => ({
        jobs: s.jobs.map((job) =>
          job._id === e.jobId
            ? {
                ...job,
                status: e.status,
                progress: e.progress,
                metrics: e.newMetrics.length ? [...job.metrics, ...e.newMetrics] : job.metrics,
                ...(e.ggufFilename ? { gguf_filename: e.ggufFilename } : {}),
                ...(e.error ? { error: e.error } : {}),
              }
            : job,
        ),
      }));
      // A job we don't know about yet (started in another tab), or one that just finished →
      // resync from Mongo so the list and the final artifact fields are authoritative.
      if (wasTerminal || !get().jobs.some((j) => j._id === e.jobId)) {
        void get().hydrate();
      }
    });

    set({ wired: true });
  },

  hydrate: async () => {
    try {
      const jobs = await finetuneJobsApi.list();
      set({ jobs, loading: false, error: false });
    } catch {
      set({ loading: false, error: true });
    }
  },
}));
