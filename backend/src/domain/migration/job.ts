import { createLogger } from '../../config/logger';

const log = createLogger('migration-job');

/**
 * The single-flight job behind the export and import buttons.
 *
 * Progress is **polled** over `GET /api/migration/job` rather than pushed over the EventBus. The bus
 * and its WS bridge carry one agent turn's events; a migration is neither an agent nor a turn, and
 * the import path deliberately drops every socket as its first act (see `maintenance-mode.ts`) —
 * a progress channel that dies the moment the interesting part starts is worse than no channel.
 * One poll a second against an in-memory object is the whole cost.
 *
 * Single-flight is not a nicety: two concurrent exports would each hold a multi-GB write, and two
 * concurrent *imports* would interleave collection drops.
 */

export type JobKind = 'export' | 'preflight' | 'restore';
export type JobStatus = 'running' | 'done' | 'error';

export interface JobState {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Human-readable current step, e.g. "Exporting forum_posts". */
  phase: string;
  /** Units processed and the planned total (documents + vector points). 0 total = indeterminate. */
  done: number;
  total: number;
  started_at: string;
  ended_at?: string;
  warnings: string[];
  error?: string;
  /** Free-form payload for the finished job (the archive record, the preflight report, …). */
  result?: unknown;
}

export interface ProgressSink {
  phase(text: string): void;
  total(n: number): void;
  advance(n: number): void;
  warn(text: string): void;
}

let current: JobState | null = null;

export function currentJob(): JobState | null {
  return current;
}

export function isBusy(): boolean {
  return current?.status === 'running';
}

export class JobBusyError extends Error {
  constructor(kind: JobKind) {
    super(`a ${kind} is already running`);
    this.name = 'JobBusyError';
  }
}

/**
 * Start a job, returning its initial state immediately — the caller answers the HTTP request while
 * the work continues in the background and the UI polls.
 */
export function startJob<T>(
  kind: JobKind,
  id: string,
  work: (progress: ProgressSink) => Promise<T>,
): JobState {
  if (isBusy()) throw new JobBusyError(current!.kind);

  const state: JobState = {
    id,
    kind,
    status: 'running',
    phase: 'Starting',
    done: 0,
    total: 0,
    started_at: new Date().toISOString(),
    warnings: [],
  };
  current = state;

  const progress: ProgressSink = {
    phase: (text) => {
      state.phase = text;
    },
    total: (n) => {
      state.total = n;
    },
    advance: (n) => {
      state.done += n;
    },
    warn: (text) => {
      // Bounded: a pathological archive could otherwise grow this without limit in memory.
      if (state.warnings.length < 200) state.warnings.push(text);
    },
  };

  void work(progress)
    .then((result) => {
      state.status = 'done';
      state.phase = 'Finished';
      state.result = result;
      state.ended_at = new Date().toISOString();
      log.info({ kind, id }, 'migration job finished');
    })
    .catch((err: unknown) => {
      state.status = 'error';
      state.phase = 'Failed';
      state.error = err instanceof Error ? err.message : String(err);
      state.ended_at = new Date().toISOString();
      log.error({ err, kind, id }, 'migration job failed');
    });

  return state;
}

/** Forget a finished job so the page returns to its idle state. Refuses while one is running. */
export function clearJob(): boolean {
  if (isBusy()) return false;
  current = null;
  return true;
}
