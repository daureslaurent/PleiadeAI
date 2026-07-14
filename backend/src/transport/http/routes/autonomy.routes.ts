import { Router } from 'express';
import { Types } from 'mongoose';
import { getAgenda, AUTONOMOUS_RUN_JOB } from '../../../autonomy/agenda.setup';
import { parseCron, applyCron } from '../../../autonomy/cron';
import { env } from '../../../config/env';
import { runResultRepository } from '../../../domain/autonomy/run-result.repository';

/** Autonomy control board: schedule, list, cancel, and the global kill switch. */
export const autonomyRouter = Router();

autonomyRouter.get('/jobs', async (_req, res) => {
  const jobs = await getAgenda().jobs({ name: AUTONOMOUS_RUN_JOB });
  res.json(
    jobs.map((j) => ({
      id: String(j.attrs._id),
      data: j.attrs.data,
      nextRunAt: j.attrs.nextRunAt,
      lastRunAt: j.attrs.lastRunAt,
      cron: j.attrs.repeatInterval ?? j.attrs.data.cron ?? null,
      once: !j.attrs.repeatInterval,
      timezone: env.SCHEDULE_TZ,
    })),
  );
});

/**
 * Schedule an autonomous run. Cron-only, same semantics as the agent's `schedule_task` tool:
 * `cron` is a strict 5-field expression evaluated in SCHEDULE_TZ; `once: true` runs a single time
 * at the next occurrence, otherwise the job repeats.
 */
autonomyRouter.post('/jobs', async (req, res) => {
  const { agentName, prompt, cron, once, alert } = req.body ?? {};
  if (!agentName || !prompt || !cron) {
    res.status(400).json({ error: 'agentName, prompt and cron are required' });
    return;
  }
  const parsed = parseCron(String(cron).trim());
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const job = getAgenda().create(AUTONOMOUS_RUN_JOB, { agentName, prompt, alert });
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
  const { agentName, prompt, cron, once, alert } = req.body ?? {};
  const [job] = await getAgenda().jobs({
    _id: new Types.ObjectId(req.params.id),
    name: AUTONOMOUS_RUN_JOB,
  });
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  job.attrs.data = {
    ...job.attrs.data,
    agentName: agentName ?? job.attrs.data.agentName,
    prompt: prompt ?? job.attrs.data.prompt,
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
    name: AUTONOMOUS_RUN_JOB,
  });
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Carry the schedule id so the ad-hoc run lands in the same result history as scheduled runs.
  await getAgenda().now(AUTONOMOUS_RUN_JOB, {
    ...job.attrs.data,
    scheduleId: job.attrs.data.scheduleId ?? String(job.attrs._id),
  });
  res.json({ ok: true });
});

autonomyRouter.delete('/jobs/:id', async (req, res) => {
  const removed = await getAgenda().cancel({ _id: new Types.ObjectId(req.params.id) });
  res.json({ cancelled: removed ?? 0 });
});

/** Global execution kill switch: cancels every scheduled autonomous job. */
autonomyRouter.post('/kill', async (_req, res) => {
  const removed = await getAgenda().cancel({ name: AUTONOMOUS_RUN_JOB });
  res.json({ ok: true, cancelled: removed ?? 0 });
});
