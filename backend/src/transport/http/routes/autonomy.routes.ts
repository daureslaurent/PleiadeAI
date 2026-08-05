import { Router } from 'express';
import { Types } from 'mongoose';
import { getAgenda, AUTONOMOUS_RUN_JOB, FLOW_RUN_JOB } from '../../../autonomy/agenda.setup';
import { parseCron, applyCron, previewCron } from '../../../autonomy/cron';
import { env } from '../../../config/env';
import { runResultRepository } from '../../../domain/autonomy/run-result.repository';
import { flowRepository } from '../../../domain/flows/flow.repository';

/** Autonomy control board: schedule, list, cancel, and the global kill switch. */
export const autonomyRouter = Router();

/**
 * The two things a schedule can run: an agent prompt, or a saved flow (FLOWS_PLAN.md §7). Both are
 * ordinary Agenda jobs with the same cron semantics and the same result history, so the whole control
 * board — list, edit, run-now, cancel, kill — treats them uniformly; only the payload differs.
 */
const JOB_NAMES = [AUTONOMOUS_RUN_JOB, FLOW_RUN_JOB];

function jobNameFor(kind: unknown): string {
  return String(kind ?? 'agent') === 'flow' ? FLOW_RUN_JOB : AUTONOMOUS_RUN_JOB;
}

autonomyRouter.get('/jobs', async (_req, res) => {
  const jobs = await getAgenda().jobs({ name: { $in: JOB_NAMES } });
  // Run-now / busy-requeue create ad-hoc *clones* of a schedule (same `data.scheduleId`, different
  // `_id`). They are executions, not schedules: hide them from the list, but fold their liveness
  // (Agenda's `lockedAt`) back into the schedule they belong to.
  const runningSchedules = new Set(
    jobs
      .filter((j) => j.attrs.lockedAt)
      .map((j) => String(j.attrs.data.scheduleId ?? j.attrs._id)),
  );
  const schedules = jobs.filter(
    (j) => !j.attrs.data.scheduleId || j.attrs.data.scheduleId === String(j.attrs._id),
  );
  res.json(
    schedules.map((j) => ({
      id: String(j.attrs._id),
      kind: j.attrs.name === FLOW_RUN_JOB ? 'flow' : 'agent',
      data: j.attrs.data,
      nextRunAt: j.attrs.nextRunAt,
      lastRunAt: j.attrs.lastRunAt,
      cron: j.attrs.repeatInterval ?? j.attrs.data.cron ?? null,
      once: !j.attrs.repeatInterval,
      timezone: env.SCHEDULE_TZ,
      running: runningSchedules.has(String(j.attrs._id)),
    })),
  );
});

/** Cron helper for the schedule form: validity + the next occurrences in SCHEDULE_TZ. */
autonomyRouter.get('/cron/preview', (req, res) => {
  const expr = typeof req.query.expr === 'string' ? req.query.expr.trim() : '';
  if (!expr) {
    res.status(400).json({ error: 'expr query parameter is required' });
    return;
  }
  res.json(previewCron(expr));
});

/**
 * Schedule an autonomous run. Cron-only, same semantics as the agent's `schedule_task` tool:
 * `cron` is a strict 5-field expression evaluated in SCHEDULE_TZ; `once: true` runs a single time
 * at the next occurrence, otherwise the job repeats.
 */
autonomyRouter.post('/jobs', async (req, res) => {
  const { agentName, prompt, cron, once, alert, kind, flowId, inputs } = req.body ?? {};
  if (!cron) {
    res.status(400).json({ error: 'cron is required' });
    return;
  }

  let payload: Record<string, unknown>;
  if (jobNameFor(kind) === FLOW_RUN_JOB) {
    const flow = flowId ? await flowRepository.findById(String(flowId)) : null;
    if (!flow) {
      res.status(400).json({ error: 'flowId must name an existing flow' });
      return;
    }
    payload = { flowId: String(flow._id), flowName: flow.name, inputs: inputs ?? {}, alert };
  } else {
    if (!agentName || !prompt) {
      res.status(400).json({ error: 'agentName and prompt are required' });
      return;
    }
    payload = { agentName, prompt, alert };
  }

  const parsed = parseCron(String(cron).trim());
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const job = getAgenda().create(jobNameFor(kind), payload);
  applyCron(job, String(cron).trim(), Boolean(once), parsed.value.next);
  await job.save();
  // Stamp the schedule id into the payload so every run (scheduled or run-now) groups its results.
  job.attrs.data.scheduleId = String(job.attrs._id);
  await job.save();
  res.status(201).json({ id: String(job.attrs._id) });
});

/** All previous run results for one schedule, newest first (full markdown output). */
autonomyRouter.get('/jobs/:id/results', async (req, res) => {
  const results = await runResultRepository.listBySchedule(req.params.id);
  res.json(
    results.map((r) => ({
      id: String(r._id),
      status: r.status,
      output: r.output,
      prompt: r.prompt,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
  );
});

/**
 * Update an existing scheduled job in place: prompt, alert flag, and/or the schedule itself
 * (`cron` + `once`, same cron-only semantics as create — `once` defaults to the job's current
 * mode when omitted).
 */
autonomyRouter.put('/jobs/:id', async (req, res) => {
  const { agentName, prompt, cron, once, alert, inputs } = req.body ?? {};
  const [job] = await getAgenda().jobs({
    _id: new Types.ObjectId(req.params.id),
    name: { $in: JOB_NAMES },
  });
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // A schedule's kind is fixed at creation: switching an agent prompt into a flow run in place would
  // silently orphan its result history, which is keyed by the schedule id.
  job.attrs.data = {
    ...job.attrs.data,
    ...(job.attrs.name === FLOW_RUN_JOB
      ? { inputs: inputs ?? job.attrs.data.inputs }
      : { agentName: agentName ?? job.attrs.data.agentName, prompt: prompt ?? job.attrs.data.prompt }),
    alert: alert ?? job.attrs.data.alert,
    scheduleId: job.attrs.data.scheduleId ?? String(job.attrs._id),
  };

  if (cron) {
    const parsed = parseCron(String(cron).trim());
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const effectiveOnce = once === undefined ? !job.attrs.repeatInterval : Boolean(once);
    applyCron(job, String(cron).trim(), effectiveOnce, parsed.value.next);
  }

  await job.save();
  res.json({ id: String(job.attrs._id) });
});

/** Fire a scheduled job immediately, without disturbing its recurring schedule. */
autonomyRouter.post('/jobs/:id/run', async (req, res) => {
  const [job] = await getAgenda().jobs({
    _id: new Types.ObjectId(req.params.id),
    name: { $in: JOB_NAMES },
  });
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Carry the schedule id so the ad-hoc run lands in the same result history as scheduled runs.
  await getAgenda().now(job.attrs.name, {
    ...job.attrs.data,
    scheduleId: job.attrs.data.scheduleId ?? String(job.attrs._id),
  });
  res.json({ ok: true });
});

autonomyRouter.delete('/jobs/:id', async (req, res) => {
  const removed = await getAgenda().cancel({ _id: new Types.ObjectId(req.params.id) });
  res.json({ cancelled: removed ?? 0 });
});

/** Global execution kill switch: cancels every scheduled autonomous job, agent and flow alike. */
autonomyRouter.post('/kill', async (_req, res) => {
  const removed = await getAgenda().cancel({ name: { $in: JOB_NAMES } });
  res.json({ ok: true, cancelled: removed ?? 0 });
});
