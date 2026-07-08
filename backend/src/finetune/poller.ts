import { createLogger } from '../config/logger';
import { env } from '../config/env';
import { eventBus } from '../core/event-bus/EventBus';
import { alertEngine } from '../alerts/AlertEngine';
import { finetuneJobRepository } from '../domain/finetune-jobs/finetune-job.repository';
import { finetuneServerService } from '../domain/finetune-servers/finetune-server.service';
import type { FinetuneJobDoc } from '../domain/finetune-jobs/finetune-job.model';
import type { TrainMetric } from '../domain/finetune-servers/finetune-server.service';

const log = createLogger('finetune-poller');

/**
 * Background poller for tracked fine-tune jobs (spec: Fine-Tuning page).
 *
 * The remote fine-tune service keeps job state in memory and has no push channel, so the backend
 * pulls: every tick it refreshes each non-terminal `finetune_jobs` document, persists the diff, and
 * emits `finetune:job_update` (only the *newly observed* metric datapoints) so the UI's loss curve
 * advances live. On a terminal transition it fires the dual alert (inbox + Telegram) exactly once.
 *
 * Failures are per-job and non-fatal: an unreachable server just leaves the job untouched until the
 * next tick. Ticks never overlap (`running` guard), so a slow server can't stack timers.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;

/** Compare against the persisted series so we only ship (and append) genuinely new datapoints. */
function newMetricsSince(existing: FinetuneJobDoc['metrics'], remote: TrainMetric[]): TrainMetric[] {
  if (remote.length <= existing.length) return [];
  return remote.slice(existing.length);
}

async function pollOne(job: FinetuneJobDoc): Promise<void> {
  const remote = await finetuneServerService.getRemoteJob(job.server_id, job.remote_job_id);

  const fresh = newMetricsSince(job.metrics, remote.metrics ?? []);
  const statusChanged = remote.status !== job.status;
  const progressChanged = remote.progress !== job.progress;
  if (!statusChanged && !progressChanged && fresh.length === 0) return;

  const isTerminal = remote.status === 'done' || remote.status === 'failed';
  const patch: Record<string, unknown> = {
    status: remote.status,
    progress: remote.progress,
    log_tail: remote.log_tail ?? [],
  };
  if (remote.gguf_filename) patch.gguf_filename = remote.gguf_filename;
  if (remote.error) patch.error = remote.error;
  if (isTerminal) patch.finished_at = new Date();
  // The remote already ring-buffers its series; mirror it wholesale rather than $push-ing.
  if (fresh.length) patch.metrics = remote.metrics;

  await finetuneJobRepository.update(job._id, patch);

  eventBus.emit('finetune:job_update', {
    jobId: String(job._id),
    serverId: String(job.server_id),
    runName: job.run_name,
    status: remote.status,
    progress: remote.progress,
    newMetrics: fresh,
    ggufFilename: remote.gguf_filename,
    error: remote.error,
  });

  // Terminal transition → dual alert, once. Guarded by `statusChanged` so a re-poll can't re-notify.
  if (isTerminal && statusChanged) {
    const ok = remote.status === 'done';
    await alertEngine.dispatch({
      title: ok ? `Fine-tune finished: ${job.run_name}` : `Fine-tune failed: ${job.run_name}`,
      content: ok
        ? `Model "${job.base_model}" finished training. GGUF: ${remote.gguf_filename ?? 'n/a'}. Download it from the Fine-Tuning page.`
        : `Training of "${job.base_model}" failed: ${remote.error ?? 'unknown error'}`,
    });
    log.info({ jobId: String(job._id), status: remote.status }, 'fine-tune job reached terminal state');
  }
}

async function tick(): Promise<void> {
  if (running) return; // a slow server must not stack overlapping ticks
  running = true;
  try {
    const active = await finetuneJobRepository.findActive();
    if (active.length === 0) return;
    // Isolate failures: one unreachable server shouldn't stop the others from updating.
    await Promise.allSettled(
      active.map((job) =>
        pollOne(job).catch((err) => {
          log.warn(
            { jobId: String(job._id), err: err instanceof Error ? err.message : String(err) },
            'poll failed; will retry next tick',
          );
        }),
      ),
    );
  } catch (err) {
    log.error({ err }, 'finetune poll tick failed');
  } finally {
    running = false;
  }
}

/** Start the poll loop. Idempotent. Called once at boot from `index.ts`. */
export function startFinetunePoller(): void {
  if (timer) return;
  const interval = env.FINETUNE_POLL_INTERVAL_MS;
  timer = setInterval(() => void tick(), interval);
  timer.unref();
  log.info({ intervalMs: interval }, 'finetune poller started');
}

export function stopFinetunePoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
