import { Router } from 'express';
import { autoLoopRepository } from '../../../domain/auto-loops/auto-loop.repository';
import { autoLoopRunner } from '../../../autonomy/AutoLoopRunner';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { sessionRepository } from '../../../domain/sessions/session.repository';

/**
 * The composer's Loop panel (`AUTO_AGENT_PLAN.md` §5). Deliberately REST rather than socket events:
 * arming a loop is a durable state change the operator makes once, not a stream — and it has to work
 * on a page that has just loaded, before any session subscription exists. The *live* half (status,
 * iteration, countdown) comes back over the socket as `auto_loop`.
 */
export const autoLoopsRouter = Router();

/** Bounds on the interval, mirroring the runner's own floor. */
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 24 * 60 * 60;

autoLoopsRouter.get('/:sessionId', async (req, res) => {
  const loop = await autoLoopRepository.findBySession(req.params.sessionId);
  // A conversation that has never looped is the normal case, not a 404 — the panel opens on it.
  res.json(loop ?? null);
});

autoLoopsRouter.post('/:sessionId/start', async (req, res) => {
  const { sessionId } = req.params;
  const body = req.body ?? {};

  const session = await sessionRepository.findById(sessionId);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const agent = await agentRepository.findById(String(session.agent_id));
  if (!agent) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  // The flag is the capability gate: refuse here as well as hiding the button, so a stale tab (or a
  // direct API call) can't start a loop on an agent the operator has since taken out of auto mode.
  if (!agent.auto_mode) {
    res.status(409).json({ error: `"${agent.name}" is not in auto mode` });
    return;
  }

  const goal = String(body.goal ?? '').trim();
  if (!goal) {
    res.status(400).json({ error: 'a goal is required — it is what every iteration is measured against' });
    return;
  }
  const intervalSec = Math.min(
    MAX_INTERVAL_SEC,
    Math.max(MIN_INTERVAL_SEC, Number(body.intervalSec) || 60),
  );

  const loop = await autoLoopRepository.start({
    sessionId,
    agentId: String(agent._id),
    agentName: agent.name,
    goal,
    seed: String(body.seed ?? '').trim(),
    continueText: String(body.continueText ?? '').trim(),
    intervalSec,
  });
  await autoLoopRunner.start(loop);
  res.status(201).json(loop);
});

autoLoopsRouter.post('/:sessionId/stop', async (req, res) => {
  const loop = await autoLoopRunner.stop(req.params.sessionId);
  if (!loop) {
    res.status(404).json({ error: 'no loop on this session' });
    return;
  }
  res.json(loop);
});
