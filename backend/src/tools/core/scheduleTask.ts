import { Types } from 'mongoose';
import { getAgenda, AUTONOMOUS_RUN_JOB, type AutonomousJobData } from '../../autonomy/agenda.setup';
import { createLogger } from '../../config/logger';
import type { Tool, ToolContext, ToolResult } from '../types';

const log = createLogger('tool:schedule_task');

/** Shape returned when describing a scheduled job to the LLM. */
function describe(job: { attrs: Record<string, any> }) {
  return {
    id: String(job.attrs._id),
    prompt: job.attrs.data?.prompt,
    when: job.attrs.repeatInterval ? undefined : job.attrs.nextRunAt,
    interval: job.attrs.repeatInterval ?? undefined,
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
 * Ownership is explicit: `create` stamps `ownerAgent` (and the run-as `agentName`) with the calling
 * agent, and `list`/`update`/`cancel` only ever see jobs whose `ownerAgent` is this same agent — an
 * agent can neither inspect nor mutate another agent's schedule, and operator-created (UI) jobs are
 * invisible here. `when` produces a one-off run; `interval` (cron or human, e.g. "30 minutes")
 * produces a repeating job.
 */
export const scheduleTask: Tool = {
  name: 'schedule_task',
  description:
    'CRUD over your own scheduled autonomous runs. action="create" queues a task (use "when" for a ' +
    'one-off like "in 10 minutes" or an ISO date, or "interval" for a recurring cron/"30 minutes" ' +
    'schedule); action="list" shows your tasks; action="update" edits one by id; action="cancel" ' +
    'removes one by id. You can only see and manage tasks you own.',
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
      when: {
        type: 'string',
        description:
          'For a one-off task: when to run, e.g. "in 10 minutes", "tomorrow at 9am", or an ISO date. Ignored if "interval" is set.',
      },
      interval: {
        type: 'string',
        description:
          'For a recurring task: a cron expression ("0 * * * *") or human interval ("30 minutes"). Takes precedence over "when".',
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

      const interval = args.interval ? String(args.interval).trim() : '';
      const when = args.when ? String(args.when).trim() : '';
      if (interval) {
        job.attrs.nextRunAt = null;
        job.repeatEvery(interval);
      } else if (when) {
        job.attrs.repeatInterval = undefined;
        job.schedule(when);
      }
      await job.save();

      log.info({ agent: ctx.agentName, jobId }, 'scheduled task updated');
      return { result: { ok: true, task: describe(job) } };
    }

    if (action === 'create') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return { result: { ok: false, error: 'prompt is required to create a task' } };
      const interval = args.interval ? String(args.interval).trim() : '';
      const when = args.when ? String(args.when).trim() : '';

      const data: AutonomousJobData = {
        agentName: ctx.agentName,
        ownerAgent: ctx.agentName,
        prompt,
        alert: args.alert === undefined ? true : Boolean(args.alert),
      };

      const job = interval
        ? agenda.create(AUTONOMOUS_RUN_JOB, data).repeatEvery(interval)
        : agenda.create(AUTONOMOUS_RUN_JOB, data).schedule(when || 'in 1 minute');
      await job.save();

      log.info(
        { agent: ctx.agentName, jobId: String(job.attrs._id), interval: interval || undefined },
        'scheduled task created',
      );
      return { result: { ok: true, task: describe(job) } };
    }

    return { result: { ok: false, error: `unknown action "${action}"` } };
  },
};
