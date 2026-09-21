import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { runQueueRepository, type RunQueueInput } from './run-queue.repository';
import type { RunQueueDoc } from './run-queue.model';

const log = createLogger('run-queue');

/**
 * What a source does with one of its rows when its turn comes. `onSession` is called as soon as the
 * conversation exists, so the row is clickable while the turn is still streaming.
 */
export type RunQueueHandler = (row: RunQueueDoc, onSession: (sessionId: string) => void) => Promise<void>;

/**
 * The fleet's single lane for autonomous turns (`RUN_QUEUE_PLAN.md`).
 *
 * One turn at a time, across *every* source that feeds it. That is the whole point: before this,
 * `gitlab-wake-runner.ts` and `forum-wake-queue.ts` were each serial within themselves and neither
 * knew the other existed, so a GitLab wake and a forum wake could hold the one inference server at
 * the same time and each wonder why it was so slow.
 *
 * The lane knows nothing about GitLab, the forum or cron: a source registers a handler at boot and
 * its rows carry their own `payload`. That is also what makes a restart resumable — the queue is in
 * Mongo, and nothing about a waiting row lives in this process.
 *
 * Operator chats and Telegram deliberately do not queue here (§2): a human is waiting on those, and
 * `SessionLock` already makes a background turn yield to a live chat.
 */
class RunQueue {
  private readonly handlers = new Map<string, RunQueueHandler>();
  private draining = false;
  private started = false;
  private paused = false;
  /**
   * A restore has quiesced the instance (`maintenance-mode.ts`). Separate from `paused` because it
   * is not the operator's choice and must not be written to a database that is being replaced.
   */
  private held = false;

  /** A source declares how to run its rows. Called at import time, before `start()`. */
  register(source: string, handler: RunQueueHandler): void {
    this.handlers.set(source, handler);
  }

  /**
   * Recover what a dead process left behind, then start draining.
   *
   * Called once at boot, *after* every source module has been imported: a row whose handler has not
   * registered yet would otherwise be failed for a reason that is about boot order rather than
   * about the row.
   */
  async start(): Promise<void> {
    this.started = true;
    this.paused = (await settingsService.get()).run_queue_paused;
    await runQueueRepository.recover().catch((err) => log.error({ err: String(err) }, 'recover failed'));
    const waiting = await runQueueRepository.countQueued().catch(() => 0);
    if (waiting) log.info({ waiting }, 'runs waiting from before the restart');
    void this.drain();
  }

  /**
   * Put a turn in the lane. Returns the row, or `null` when the source said this is a duplicate of
   * something already waiting (GitLab retries deliveries; a poll tick re-reads a pending to-do).
   */
  async enqueue(input: RunQueueInput): Promise<RunQueueDoc | null> {
    if (input.dedupeKey && (await runQueueRepository.isPending(input.dedupeKey))) {
      log.debug({ dedupe: input.dedupeKey }, 'already queued — not enqueued twice');
      return null;
    }
    const row = await runQueueRepository.insert(input);
    log.info(
      { source: row.source, kind: row.kind, agent: row.agent_name, id: String(row._id) },
      'run queued',
    );
    void this.drain();
    return row;
  }

  /** Stop starting new turns. Whatever is running finishes — stopping that is the Workspace's job. */
  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    await settingsService.update({ run_queue_paused: paused });
    log.info({ paused }, paused ? 'run queue paused' : 'run queue resumed');
    if (!paused) void this.drain();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Stop starting turns for a restore, without touching the operator's own pause switch. */
  hold(on: boolean): void {
    this.held = on;
    if (!on) void this.drain();
  }

  /** True while a turn is running or one is waiting. */
  isBusy(): boolean {
    return this.draining;
  }

  cancel(id: string): Promise<boolean> {
    return runQueueRepository.cancel(id);
  }

  promote(id: string): Promise<boolean> {
    return runQueueRepository.promote(id);
  }

  /**
   * What the operator sees. `source` narrows the lists to one subsystem — the GitLab page asks for
   * its own rows — while `holder` always names whatever is actually running, so a GitLab row
   * waiting behind a forum turn is explained rather than mysteriously stuck.
   */
  async snapshot(opts: { source?: string; limit?: number } = {}): Promise<{
    paused: boolean;
    started: boolean;
    holder: RunQueueDoc | null;
    running: RunQueueDoc | null;
    queued: RunQueueDoc[];
    history: RunQueueDoc[];
    total_queued: number;
  }> {
    const live = await runQueueRepository.live();
    const holder = live.find((r) => r.status === 'running') ?? null;
    const queued = live.filter((r) => r.status === 'queued');
    return {
      paused: this.paused,
      started: this.started,
      holder,
      running: holder && (!opts.source || holder.source === opts.source) ? holder : null,
      queued: opts.source ? queued.filter((r) => r.source === opts.source) : queued,
      history: await runQueueRepository.history({ source: opts.source, limit: opts.limit }),
      total_queued: queued.length,
    };
  }

  /** One row at a time, for as long as there are rows. A re-entrant call returns; the loop takes them. */
  private async drain(): Promise<void> {
    if (this.draining || !this.started) return;
    this.draining = true;
    try {
      while (!this.paused && !this.held) {
        const row = await runQueueRepository.claim();
        if (!row) break;
        await this.runOne(row);
      }
    } catch (err) {
      log.error({ err: String(err) }, 'run queue drain failed');
    } finally {
      this.draining = false;
    }
  }

  private async runOne(row: RunQueueDoc): Promise<void> {
    const id = String(row._id);
    const handler = this.handlers.get(row.source);
    if (!handler) {
      log.error({ source: row.source, id }, 'no handler registered for this source — row failed');
      await runQueueRepository.finish(id, 'failed', `no handler registered for source "${row.source}"`);
      return;
    }
    const waited = Date.now() - new Date(row.queued_at).getTime();
    log.info({ source: row.source, agent: row.agent_name, id, waited_ms: waited }, 'run starting');
    try {
      await handler(row, (sessionId) => void runQueueRepository.attachSession(id, sessionId));
      await runQueueRepository.finish(id, 'done');
    } catch (err) {
      log.error({ err: String(err), source: row.source, id }, 'run failed');
      await runQueueRepository.finish(id, 'failed', err instanceof Error ? err.message : String(err));
    }
  }
}

export const runQueue = new RunQueue();
