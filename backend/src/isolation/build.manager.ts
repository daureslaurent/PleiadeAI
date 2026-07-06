import { createLogger } from '../config/logger';
import { imageRepository } from '../domain/images/image.repository';
import { isolationRepository } from '../domain/isolations/isolation.repository';
import { agentRepository } from '../domain/agents/agent.repository';
import { dockerService } from './docker.service';
import { imgImageName } from './names';
import { agentContainerManager } from './AgentContainerManager';

const log = createLogger('build-manager');

/** Cap the buffered log per job so a runaway build can't grow memory without bound (~256 KB). */
const MAX_LOG_BYTES = 256 * 1024;

/** A frame pushed to attached log-stream subscribers. */
export type BuildEvent =
  | { type: 'log'; chunk: string }
  | { type: 'done'; size: number | null }
  | { type: 'error'; message: string };

type JobStatus = 'queued' | 'running' | 'done' | 'error';

interface BuildJob {
  imageId: string;
  status: JobStatus;
  log: string;
  error?: string;
  size?: number | null;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  subscribers: Set<(ev: BuildEvent) => void>;
}

/** Public snapshot of a job for the overview / active-builds UI (no subscriber set). */
export interface BuildJobSnapshot {
  image_id: string;
  status: JobStatus;
  queued_at: number;
  started_at?: number;
  ended_at?: number;
  error?: string;
}

/**
 * In-process background build queue. Builds are **serialised** — one `docker build` runs at a time,
 * the rest wait in FIFO order — matching the "reattach, one at a time" model. Each job keeps a
 * buffered log plus a set of live subscribers so the UI can start a build, navigate away, and
 * reattach to the running (or just-finished) log stream. Job state also mirrors onto the image doc
 * (`image_status`) so it survives a full reload / backend restart.
 */
class BuildManager {
  private readonly jobs = new Map<string, BuildJob>();
  private readonly queue: string[] = [];
  private processing = false;

  /**
   * Queue a build for an image. If one is already queued/running for it, this is a no-op (the
   * existing job is returned to the caller's attach flow). Persists `queued` immediately.
   */
  async enqueue(imageId: string): Promise<void> {
    const existing = this.jobs.get(imageId);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) return;

    this.jobs.set(imageId, {
      imageId,
      status: 'queued',
      log: '',
      queuedAt: Date.now(),
      subscribers: existing?.subscribers ?? new Set(),
    });
    this.queue.push(imageId);
    await imageRepository.update(imageId, { image_status: 'queued', last_build_error: null });
    void this.pump();
  }

  /** Current job for an image (buffered log + status), or null if none has ever run this process. */
  jobFor(imageId: string): BuildJob | null {
    return this.jobs.get(imageId) ?? null;
  }

  /** Snapshots of every job this process knows about (for the global build overview). */
  snapshots(): BuildJobSnapshot[] {
    return [...this.jobs.values()].map((j) => ({
      image_id: j.imageId,
      status: j.status,
      queued_at: j.queuedAt,
      started_at: j.startedAt,
      ended_at: j.endedAt,
      error: j.error,
    }));
  }

  /**
   * Attach a subscriber to an image's build stream. Immediately replays the buffered log, then
   * forwards live events. Returns an unsubscribe function (and whether a build is still active).
   */
  attach(imageId: string, onEvent: (ev: BuildEvent) => void): { active: boolean; detach: () => void } {
    const job = this.jobs.get(imageId);
    if (!job) return { active: false, detach: () => undefined };
    if (job.log) onEvent({ type: 'log', chunk: job.log });
    const active = job.status === 'queued' || job.status === 'running';
    if (!active) {
      // Terminal state already: emit the closing frame so the client's stream resolves.
      if (job.status === 'done') onEvent({ type: 'done', size: job.size ?? null });
      else if (job.status === 'error') onEvent({ type: 'error', message: job.error ?? 'build failed' });
      return { active: false, detach: () => undefined };
    }
    job.subscribers.add(onEvent);
    return { active: true, detach: () => job.subscribers.delete(onEvent) };
  }

  private broadcast(job: BuildJob, ev: BuildEvent): void {
    for (const sub of job.subscribers) {
      try {
        sub(ev);
      } catch {
        /* a dead subscriber must not break the build */
      }
    }
  }

  private appendLog(job: BuildJob, chunk: string): void {
    job.log += chunk;
    if (job.log.length > MAX_LOG_BYTES) job.log = job.log.slice(-MAX_LOG_BYTES);
    this.broadcast(job, { type: 'log', chunk });
  }

  /** Drain the queue one job at a time. */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const imageId = this.queue.shift()!;
        const job = this.jobs.get(imageId);
        if (!job || job.status !== 'queued') continue;
        await this.runJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  private async runJob(job: BuildJob): Promise<void> {
    const imageId = job.imageId;
    const image = await imageRepository.findById(imageId);
    if (!image) {
      // Image was deleted between enqueue and run — drop the job silently.
      job.status = 'error';
      job.error = 'image was deleted';
      job.endedAt = Date.now();
      return;
    }

    job.status = 'running';
    job.startedAt = Date.now();
    await imageRepository.update(imageId, { image_status: 'building', last_build_error: null });

    const tag = imgImageName(imageId);
    try {
      await dockerService.build(tag, image.dockerfile ?? '', (chunk) => this.appendLog(job, chunk), {
        buildArgs: (image.build_args ?? []).map((a) => ({ key: a.key, value: a.value ?? '' })),
        noCache: image.no_cache,
        pull: image.pull,
        timeoutMs: image.build_timeout_ms ?? undefined,
      });
      const size = await dockerService.imageSize(tag);
      job.status = 'done';
      job.size = size;
      job.endedAt = Date.now();
      await imageRepository.update(imageId, {
        image_status: 'built',
        image_built_at: new Date(),
        image_size: size,
        last_build_error: null,
      });
      this.broadcast(job, { type: 'done', size });
      await this.recreateReferencingContainers(imageId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      job.status = 'error';
      job.error = message;
      job.endedAt = Date.now();
      log.error({ imageId, err: message }, 'image build failed');
      await imageRepository.update(imageId, { image_status: 'error', last_build_error: message });
      this.broadcast(job, { type: 'error', message });
    } finally {
      job.subscribers.clear();
    }
  }

  /**
   * After a successful (re)build, drop the containers of every agent whose profile references this
   * image, so they recreate from the fresh image layers on their next run (mirrors the old
   * per-profile build behaviour, now fanned out across all referencing profiles).
   */
  private async recreateReferencingContainers(imageId: string): Promise<void> {
    try {
      const profiles = await isolationRepository.listByImage(imageId);
      for (const profile of profiles) {
        const agents = await agentRepository.listByIsolation(String(profile._id));
        for (const agent of agents) {
          await agentContainerManager
            .removeAgentContainer(String(agent._id))
            .catch(() => undefined);
        }
      }
    } catch (err) {
      log.warn({ imageId, err: String(err) }, 'post-build container recreate failed');
    }
  }
}

export const buildManager = new BuildManager();
