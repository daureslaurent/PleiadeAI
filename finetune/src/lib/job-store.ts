import { randomUUID } from 'node:crypto';
import type { Job, JobPhase, JobStatus, TrainMetric, TrainingPlan, TrainRequest } from '../types';
import { createLogger } from '../config/logger';

const log = createLogger('job-store');

/** Keep the last N log lines per job so `GET /jobs/:id` can surface recent output. */
const LOG_TAIL_MAX = 200;
/** Cap the loss curve so a long run can't grow the job record unbounded. */
const METRICS_MAX = 2000;

/**
 * In-memory job registry + a strict single-concurrency queue.
 *
 * Only one training may run at a time because each run consumes BOTH GPUs. Extra
 * `POST /train` requests are accepted immediately (202) and queued; the runner drains
 * them one at a time via a promise chain — no external queue dependency.
 *
 * NOTE (v1 limitation): job state lives only in this process. A restart loses history
 * and abandons any in-flight child process.
 * TODO: persist to disk (RUNS_DIR/<id>/job.json) or Mongo so status survives restarts.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  /** Tail of the single-slot queue; each job awaits the previous one. */
  private tail: Promise<void> = Promise.resolve();

  create(req: TrainRequest, datasetPath: string, plan: TrainingPlan): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      run_name: req.run_name,
      base_model: req.base_model,
      dataset_path: datasetPath,
      webhook_url: req.webhook_url,
      hyperparams: req.hyperparams ?? {},
      plan,
      phase: 'queued',
      progress: 0,
      log_tail: [],
      metrics: [],
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Enqueue a job's async worker onto the single-slot chain. Returns immediately;
   * the worker runs when all prior jobs have finished. Errors are swallowed here
   * (the worker itself is responsible for marking the job failed + notifying).
   */
  enqueue(id: string, worker: () => Promise<void>): void {
    this.tail = this.tail.then(async () => {
      const job = this.jobs.get(id);
      if (!job) return;
      try {
        job.started_at = new Date().toISOString();
        this.setPhase(id, 'preparing');
        await worker();
      } catch (err) {
        log.error({ err, jobId: id }, 'job worker threw');
      }
    });
  }

  setPhase(id: string, phase: JobPhase): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.phase = phase;
    job.updated_at = new Date().toISOString();
    if (phase === 'done' || phase === 'failed') {
      job.finished_at = job.updated_at;
    }
    log.info({ jobId: id, phase }, 'job phase');
  }

  setProgress(id: string, progress: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = Math.min(1, Math.max(0, progress));
    job.updated_at = new Date().toISOString();
  }

  appendLog(id: string, line: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.log_tail.push(line);
    if (job.log_tail.length > LOG_TAIL_MAX) {
      job.log_tail.splice(0, job.log_tail.length - LOG_TAIL_MAX);
    }
  }

  /**
   * Record one parsed training datapoint (loss curve). When the trainer can't read a real
   * step number it passes 0; we then synthesize a monotonic step from the series length so
   * the curve still plots in order.
   */
  appendMetric(id: string, metric: Omit<TrainMetric, 'at'>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const step = metric.step > 0 ? metric.step : job.metrics.length + 1;
    job.metrics.push({ ...metric, step, at: new Date().toISOString() });
    if (job.metrics.length > METRICS_MAX) {
      job.metrics.splice(0, job.metrics.length - METRICS_MAX);
    }
    job.updated_at = new Date().toISOString();
  }

  markDone(id: string, artifactPath: string, ggufFilename: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.artifact_path = artifactPath;
    job.gguf_filename = ggufFilename;
    job.progress = 1;
    this.setPhase(id, 'done');
  }

  markFailed(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.error = error;
    this.setPhase(id, 'failed');
  }

  /** Public, redacted projection for the status endpoint. */
  toStatus(job: Job): JobStatus {
    return {
      job_id: job.id,
      run_name: job.run_name,
      base_model: job.base_model,
      status: job.phase,
      progress: job.progress,
      plan: job.plan,
      gguf_filename: job.gguf_filename,
      error: job.error,
      log_tail: job.log_tail,
      metrics: job.metrics,
      created_at: job.created_at,
      updated_at: job.updated_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
    };
  }
}

export const jobStore = new JobStore();
