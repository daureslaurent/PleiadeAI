import { parseExpression } from 'cron-parser';
import type { Job } from 'agenda';
import { env } from '../config/env';
import type { AutonomousJobData } from './agenda.setup';

/**
 * Strict cron validation shared by the `schedule_task` tool and the operator autonomy routes.
 * All scheduling (recurring AND one-shot) is expressed as a standard 5-field cron expression,
 * evaluated in `SCHEDULE_TZ` — free-text forms ("30 minutes", "tomorrow at 9am") are rejected so
 * agents can't create ambiguous, timezone-naïve schedules. cron-parser is pinned to the same
 * major Agenda bundles, so what validates here is exactly what Agenda will evaluate.
 */
export interface ParsedCron {
  /** The next occurrence in SCHEDULE_TZ, as an absolute Date. */
  next: Date;
  /** The timezone the expression was evaluated in. */
  timezone: string;
}

export function parseCron(expr: string): { ok: true; value: ParsedCron } | { ok: false; error: string } {
  const timezone = env.SCHEDULE_TZ;
  try {
    const interval = parseExpression(expr, { tz: timezone });
    return { ok: true, value: { next: interval.next().toDate(), timezone } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `invalid cron expression "${expr}" (${message}); expected a 5-field cron like "30 14 * * *", evaluated in ${timezone}`,
    };
  }
}

/**
 * Preview a cron expression for the UI helper: validity plus the next `count` occurrences in
 * SCHEDULE_TZ. Same parser (and thus exactly the same acceptance) as `parseCron`.
 */
export function previewCron(
  expr: string,
  count = 3,
): { valid: boolean; error: string | null; next: Date[]; timezone: string } {
  const timezone = env.SCHEDULE_TZ;
  try {
    const interval = parseExpression(expr, { tz: timezone });
    const next: Date[] = [];
    for (let i = 0; i < count; i++) next.push(interval.next().toDate());
    return { valid: true, error: null, next, timezone };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message, next: [], timezone };
  }
}

/**
 * Stamp a validated cron onto an autonomous-run job. Recurring keeps the expression in Agenda's
 * `repeatInterval` (evaluated by Agenda itself in SCHEDULE_TZ); one-shot schedules the concrete
 * next occurrence, so Agenda runs it once and completes it — the expression is kept in `data.cron`
 * for display only. Shared by the `schedule_task` tool and the operator autonomy routes.
 */
export function applyCron(job: Job<any>, cron: string, once: boolean, next: Date): void {
  const data = job.attrs.data as Partial<AutonomousJobData>;
  if (once) {
    job.attrs.repeatInterval = undefined;
    data.cron = cron;
    data.once = true;
    job.schedule(next);
  } else {
    delete data.cron;
    delete data.once;
    job.attrs.nextRunAt = null;
    job.repeatEvery(cron, { timezone: env.SCHEDULE_TZ, skipImmediate: true });
  }
}
