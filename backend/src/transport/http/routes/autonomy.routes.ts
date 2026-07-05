import { Router } from 'express';
import { Types } from 'mongoose';
import { getAgenda, AUTONOMOUS_RUN_JOB } from '../../../autonomy/agenda.setup';
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
      repeatInterval: j.attrs.repeatInterval,
    })),
  );
});

/**
 * Schedule an autonomous run. `interval` (e.g. "0 * * * *" or "30 minutes") creates a repeating
 * job; otherwise `when` (e.g. "in 10 minutes") schedules a one-off.
 */
autonomyRouter.post('/jobs', async (req, res) => {
  const { agentName, prompt, interval, when, alert } = req.body ?? {};
  if (!agentName || !prompt) {
    res.status(400).json({ error: 'agentName and prompt are required' });
    return;
  }
  const agenda = getAgenda();
  const data = { agentName, prompt, alert };
  const job = interval
    ? agenda.create(AUTONOMOUS_RUN_JOB, data).repeatEvery(interval)
    : agenda.create(AUTONOMOUS_RUN_JOB, data).schedule(when ?? 'in 1 minute');
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
 * Update an existing scheduled job in place: prompt, alert flag, and either a repeating `interval`
 * or a one-off `when`. Switching from repeating to one-off (or vice-versa) is handled by clearing
 * the opposite scheduling field before re-applying.
 */
autonomyRouter.put('/jobs/:id', async (req, res) => {
  const { agentName, prompt, interval, when, alert } = req.body ?? {};
  const [job] = await getAgenda().jobs({
    _id: new Types.ObjectId(req.params.id),
    name: AUTONOMOUS_RUN_JOB,
  });
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  job.attrs.data = {
    agentName: agentName ?? job.attrs.data.agentName,
    prompt: prompt ?? job.attrs.data.prompt,
    alert: alert ?? job.attrs.data.alert,
    scheduleId: job.attrs.data.scheduleId ?? String(job.attrs._id),
  };

  if (interval) {
    job.attrs.nextRunAt = null;
    job.repeatEvery(interval);
  } else if (when) {
    job.attrs.repeatInterval = undefined;
    job.schedule(when);
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
