import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { scheduleGenerator, unscheduleGenerator } from '../../../autonomy/agenda.setup';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { conversationGenService } from '../../../domain/conversation-gen/conversation-gen.service';
import { DEFAULT_INTERVIEWER_NAME } from '../../../domain/conversation-gen/generator.model';
import { generatorRepository } from '../../../domain/conversation-gen/generator.repository';
import { sessionRepository } from '../../../domain/sessions/session.repository';

const log = createLogger('conversation-gen-routes');

/** Conversation Generator: CRUD on the per-target rows + the sessions they produced. */
export const conversationGenRouter = Router();

/** Clean a topics payload: trimmed, non-empty, de-duplicated. */
function parseTopics(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const topics = raw.map((t) => String(t).trim()).filter(Boolean);
  return [...new Set(topics)];
}

conversationGenRouter.get('/', async (_req, res) => {
  res.json(await generatorRepository.list());
});

/** The generated sessions themselves: `GET /api/conversation-gen/sessions?generatorId=…`. */
conversationGenRouter.get('/sessions', async (req, res) => {
  const generatorId = req.query.generatorId as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const [sessions, total] = await Promise.all([
    sessionRepository.listSynthetic({ generatorId, limit }),
    sessionRepository.countSynthetic(generatorId),
  ]);
  res.json({ sessions, total });
});

conversationGenRouter.post('/', async (req, res) => {
  const targetAgentId = String(req.body?.target_agent_id ?? '');
  const target = await agentRepository.findById(targetAgentId).catch(() => null);
  if (!target) {
    res.status(404).json({ error: 'target agent not found' });
    return;
  }

  // Default the interviewer to the seeded agent; a since-renamed/deleted one must be picked explicitly.
  const interviewerId = String(req.body?.interviewer_agent_id ?? '');
  const interviewer = interviewerId
    ? await agentRepository.findById(interviewerId).catch(() => null)
    : await agentRepository.findByName(DEFAULT_INTERVIEWER_NAME);
  if (!interviewer) {
    res.status(400).json({ error: 'interviewer agent not found' });
    return;
  }

  try {
    const gen = await generatorRepository.create({
      targetAgentId: target._id,
      targetAgentName: target.name,
      interviewerAgentId: interviewer._id,
      enabled: Boolean(req.body?.enabled),
      intervalMinutes: Number(req.body?.interval_minutes) || undefined,
      turns: Number(req.body?.turns) || undefined,
      topics: parseTopics(req.body?.topics),
    });
    await scheduleGenerator(gen);
    res.status(201).json(gen);
  } catch (err) {
    // `target_agent_id` is unique: one schedule per agent, so the interval is never ambiguous.
    const message = err instanceof Error ? err.message : String(err);
    const conflict = message.includes('E11000');
    res.status(conflict ? 409 : 500).json({
      error: conflict ? `a generator already targets ${target.name}` : message,
    });
  }
});

conversationGenRouter.patch('/:id', async (req, res) => {
  const patch: Record<string, unknown> = {};

  if (req.body?.target_agent_id !== undefined) {
    const target = await agentRepository.findById(String(req.body.target_agent_id)).catch(() => null);
    if (!target) {
      res.status(404).json({ error: 'target agent not found' });
      return;
    }
    patch.target_agent_id = target._id;
    patch.target_agent_name = target.name;
  }
  if (req.body?.interviewer_agent_id !== undefined) {
    const interviewer = await agentRepository
      .findById(String(req.body.interviewer_agent_id))
      .catch(() => null);
    if (!interviewer) {
      res.status(404).json({ error: 'interviewer agent not found' });
      return;
    }
    patch.interviewer_agent_id = interviewer._id;
  }
  if (req.body?.enabled !== undefined) patch.enabled = Boolean(req.body.enabled);
  if (req.body?.interval_minutes !== undefined) {
    patch.interval_minutes = Math.max(1, Number(req.body.interval_minutes) || 60);
  }
  if (req.body?.turns !== undefined) {
    patch.turns = Math.min(20, Math.max(1, Number(req.body.turns) || 3));
  }
  const topics = parseTopics(req.body?.topics);
  if (topics) patch.topics = topics;

  const gen = await generatorRepository.update(req.params.id, patch);
  if (!gen) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Any change can move the clock (enabled/interval), so always re-register.
  await scheduleGenerator(gen);
  res.json(gen);
});

conversationGenRouter.delete('/:id', async (req, res) => {
  const gen = await generatorRepository.delete(req.params.id);
  if (!gen) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Generated sessions are kept: they're training data, and they outlive the schedule that made them.
  await unscheduleGenerator(req.params.id);
  res.status(204).end();
});

/**
 * Generate one conversation right now, off-schedule. Fire-and-forget: a conversation is several full
 * agent turns and would blow any sane HTTP timeout — the UI polls the generator row for the outcome.
 */
conversationGenRouter.post('/:id/run-now', async (req, res) => {
  const gen = await generatorRepository.findById(req.params.id);
  if (!gen) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  void conversationGenService
    .runOnce(String(gen._id))
    .catch((err) => log.error({ err: String(err) }, 'manual conversation run failed'));
  res.status(202).json({ started: true });
});
