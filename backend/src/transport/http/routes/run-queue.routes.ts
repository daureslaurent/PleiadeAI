import { Router } from 'express';
import { runQueue } from '../../../domain/run-queue/run-queue.service';
import type { RunQueueDoc } from '../../../domain/run-queue/run-queue.model';

/**
 * The fleet's run lane, for the operator (`RUN_QUEUE_PLAN.md` §4).
 *
 * Its own router rather than a corner of `gitlab.routes.ts`, because the lane is not a GitLab
 * concept even though the only page showing it today is GitLab's: a cron task and a forum wake wait
 * in the same line, and a GitLab row is explained by whatever is ahead of it.
 */
export const runQueueRouter = Router();

/** What the browser is shown. `payload` never leaves the backend — a brief can be four thousand
 *  characters of quoted issue, and the row's own fields already say what it is. */
function view(row: RunQueueDoc) {
  return {
    id: String(row._id),
    source: row.source,
    kind: row.kind,
    origin: row.origin,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    title: row.title,
    project: row.project,
    url: row.url,
    priority: row.priority,
    status: row.status,
    session_id: row.session_id,
    error: row.error,
    queued_at: row.queued_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
  };
}

/**
 * The queue as it stands. `source` narrows the lists to one subsystem; `holder` is always whatever
 * is actually running, so a GitLab row waiting behind a forum turn is explained rather than
 * appearing stuck for no reason.
 */
runQueueRouter.get('/', async (req, res) => {
  const source = typeof req.query.source === 'string' && req.query.source ? req.query.source : undefined;
  const snapshot = await runQueue.snapshot({ source, limit: Number(req.query.limit) || 25 });
  res.json({
    paused: snapshot.paused,
    total_queued: snapshot.total_queued,
    holder: snapshot.holder ? view(snapshot.holder) : null,
    running: snapshot.running ? view(snapshot.running) : null,
    queued: snapshot.queued.map(view),
    history: snapshot.history.map(view),
  });
});

/** Hold the lane. Whatever is running finishes — stopping *that* is the Workspace's stop button. */
runQueueRouter.post('/pause', async (req, res) => {
  await runQueue.setPaused(req.body?.paused !== false);
  res.json({ paused: runQueue.isPaused() });
});

/** Drop a row before it is paid for. Queued rows only. */
runQueueRouter.post('/:id/cancel', async (req, res) => {
  const ok = await runQueue.cancel(req.params.id);
  if (!ok) {
    res.status(409).json({ error: 'this run has already started or finished' });
    return;
  }
  res.json({ ok: true });
});

/** Put a row in front of everything else waiting. */
runQueueRouter.post('/:id/promote', async (req, res) => {
  const ok = await runQueue.promote(req.params.id);
  if (!ok) {
    res.status(409).json({ error: 'this run is no longer queued' });
    return;
  }
  res.json({ ok: true });
});
