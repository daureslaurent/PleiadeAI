import { Types } from 'mongoose';
import { getAgenda, AUTONOMOUS_RUN_JOB, type AutonomousJobData } from '../../autonomy/agenda.setup';
import { parseCron, applyCron } from '../../autonomy/cron';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import type { Tool, ToolContext, ToolResult } from '../types';

const log = createLogger('tool:schedule_task');

/** Shape returned when describing a scheduled job to the LLM. */
function describe(job: { attrs: Record<string, any> }) {
  const recurring = Boolean(job.attrs.repeatInterval);
  return {
    id: String(job.attrs._id),
    prompt: job.attrs.data?.prompt,
    cron: recurring ? job.attrs.repeatInterval : (job.attrs.data?.cron ?? undefined),
    once: !recurring,
    timezone: env.SCHEDULE_TZ,
    nextRunAt: job.attrs.nextRunAt ?? null,
    lastRunAt: job.attrs.lastRunAt ?? null,
    alert: job.attrs.data?.alert ?? true,
  };
}

/**
 * Fetch a single owned job by id, enforcing owner-only rights: the job must exist, be an
 * autonomous-run job, and have `ownerAgent` equal to the calling agent. Returns the job or an
 * error result the caller can return directly.
 */
async function findOwnedJob(jobId: string, ctx: ToolContext) {
  if (!Types.ObjectId.isValid(jobId)) {
    return { error: { result: { ok: false, error: 'invalid jobId' } } as ToolResult };
  }
  const [job] = await getAgenda().jobs({
    _id: new Types.ObjectId(jobId),
    name: AUTONOMOUS_RUN_JOB,
    'data.ownerAgent': ctx.agentName,
  });
  if (!job) {
    return { error: { result: { ok: false, error: 'no task with that id owned by you' } } as ToolResult };
  }
  return { job };
}

/**
 * Core autonomy tool: an agent's CRUD over its *own* scheduled autonomous runs. Each task later
 * re-enters `AgentRunner` headless (via the Agenda `AUTONOMOUS_RUN_JOB`) with the stored prompt,
 * yielding to any live user session first (spec §5).
 *
 * Scheduling is cron-only: every task — recurring or one-shot — is expressed as a strict 5-field
 * cron expression evaluated in `SCHEDULE_TZ`. `once: true` runs the task a single time at the
 * expression's next occurrence (computed here, scheduled as a concrete date, so Agenda completes
 * it after one run); otherwise the job repeats on the cron. Free-text forms are rejected by
 * `parseCron`, which keeps every schedule unambiguous and timezone-aware.
 *
 * Ownership is explicit: `create` stamps `ownerAgent` (and the run-as `agentName`) with the calling
 * agent, and `list`/`update`/`cancel` only ever see jobs whose `ownerAgent` is this same agent — an
 * agent can neither inspect nor mutate another agent's schedule, and operator-created (UI) jobs are
 * invisible here.
 */
export const scheduleTask: Tool = {
  name: 'schedule_task',
  description:
    'CRUD over your own scheduled autonomous runs. All schedules use a strict 5-field cron ' +
    `expression (minute hour day-of-month month day-of-week), evaluated in the ${env.SCHEDULE_TZ} ` +
    'timezone. action="create" queues a task: set "cron" (e.g. "0 9 * * *" = daily 09:00, ' +
    '"*/30 * * * *" = every 30 min) and "once": false for recurring or true to run a single time ' +
    'at the next matching occurrence (for "in ~10 minutes", compute the target clock time and ' +
    'express it as cron with once=true). action="list" shows your tasks; action="update" edits ' +
    'one by id; action="cancel" removes one by id. You can only see and manage tasks you own.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'cancel'],
        description: 'Which CRUD operation to perform.',
      },
      prompt: {
        type: 'string',
        description: 'For create/update: the instruction to run when the task fires.',
      },
      cron: {
        type: 'string',
        description:
          'A strict 5-field cron expression, e.g. "30 14 * * *" (14:30 daily) or "0 */2 * * 1-5" ' +
          '(every 2h on weekdays). Required for create. No free-text ("30 minutes", "tomorrow") — cron only.',
      },
      once: {
        type: 'boolean',
        description:
          'true = run a single time at the next occurrence of "cron", then done; false (default) = recur on the cron.',
      },
      alert: {
        type: 'boolean',
        description: 'Whether to send a completion alert when the task finishes (default true).',
      },
      jobId: {
        type: 'string',
        description: 'For action="update"/"cancel": the id of the task (from action="list").',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const action = String(args.action ?? '');
    const agenda = getAgenda();

    if (action === 'list') {
      const jobs = await agenda.jobs({ name: AUTONOMOUS_RUN_JOB, 'data.ownerAgent': ctx.agentName });
      return { result: { ok: true, count: jobs.length, tasks: jobs.map(describe) } };
    }

    if (action === 'cancel') {
      const jobId = String(args.jobId ?? '').trim();
      if (!jobId) return { result: { ok: false, error: 'jobId is required to cancel a task' } };
      const found = await findOwnedJob(jobId, ctx);
      if (found.error) return found.error;
      const cancelled = await agenda.cancel({
        _id: new Types.ObjectId(jobId),
        name: AUTONOMOUS_RUN_JOB,
        'data.ownerAgent': ctx.agentName,
      });
      log.info({ agent: ctx.agentName, jobId }, 'scheduled task cancelled');
      return { result: { ok: true, cancelled } };
    }

    if (action === 'update') {
      const jobId = String(args.jobId ?? '').trim();
      if (!jobId) return { result: { ok: false, error: 'jobId is required to update a task' } };
      const found = await findOwnedJob(jobId, ctx);
      if (found.error) return found.error;
      const job = found.job;

      if (args.prompt !== undefined) job.attrs.data.prompt = String(args.prompt).trim();
      if (args.alert !== undefined) job.attrs.data.alert = Boolean(args.alert);

      const cron = args.cron ? String(args.cron).trim() : '';
      if (cron) {
        const parsed = parseCron(cron);
        if (!parsed.ok) return { result: { ok: false, error: parsed.error } };
        // Omitted `once` keeps the task's current mode (no repeatInterval == it was one-shot).
        const once = args.once === undefined ? !job.attrs.repeatInterval : Boolean(args.once);
        applyCron(job, cron, once, parsed.value.next);
      } else if (args.once !== undefined) {
        return { result: { ok: false, error: 'changing "once" requires re-sending "cron" too' } };
      }
      await job.save();

      log.info({ agent: ctx.agentName, jobId }, 'scheduled task updated');
      return { result: { ok: true, task: describe(job) } };
    }

    if (action === 'create') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return { result: { ok: false, error: 'prompt is required to create a task' } };
      const cron = String(args.cron ?? '').trim();
      if (!cron) return { result: { ok: false, error: 'cron is required to create a task (5-field cron expression)' } };
      const parsed = parseCron(cron);
      if (!parsed.ok) return { result: { ok: false, error: parsed.error } };
      const once = Boolean(args.once);

      const data: AutonomousJobData = {
        agentName: ctx.agentName,
        ownerAgent: ctx.agentName,
        prompt,
        alert: args.alert === undefined ? true : Boolean(args.alert),
      };

      const job = agenda.create(AUTONOMOUS_RUN_JOB, data);
      applyCron(job, cron, once, parsed.value.next);
      await job.save();

      log.info(
        { agent: ctx.agentName, jobId: String(job.attrs._id), cron, once },
        'scheduled task created',
      );
      return { result: { ok: true, task: describe(job) } };
    }

    return { result: { ok: false, error: `unknown action "${action}"` } };
  },
};
