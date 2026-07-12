import { Router } from 'express';
import { sessionRepository } from '../../../domain/sessions/session.repository';
import { agentRepository } from '../../../domain/agents/agent.repository';

/** CRUD for conversation sessions + their message history (backs the Workspace). */
export const sessionsRouter = Router();

/**
 * List sessions for an agent: `GET /api/sessions?agentId=…&origin=user|synthetic|all`.
 * `origin` defaults to `user` — the Workspace shows the operator's own chats, not the (potentially
 * thousands of) conversations produced by the Conversation Generator.
 */
sessionsRouter.get('/', async (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  if (!agentId) {
    res.status(400).json({ error: 'agentId query param required' });
    return;
  }
  const raw = req.query.origin;
  const origin = raw === 'synthetic' || raw === 'all' ? raw : 'user';
  res.json(await sessionRepository.listByAgent(agentId, origin));
});

sessionsRouter.post('/', async (req, res) => {
  const agentId = String(req.body?.agentId ?? '');
  const agent = await agentRepository.findById(agentId).catch(() => null);
  if (!agent) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const session = await sessionRepository.create({ agentId: agent._id, agentName: agent.name });
  res.status(201).json(session);
});

sessionsRouter.patch('/:id', async (req, res) => {
  const session = await sessionRepository.rename(req.params.id, String(req.body?.title ?? ''));
  if (!session) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(session);
});

sessionsRouter.delete('/:id', async (req, res) => {
  const session = await sessionRepository.delete(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

sessionsRouter.get('/:id/messages', async (req, res) => {
  res.json(await sessionRepository.messages(req.params.id));
});

sessionsRouter.post('/:id/messages', async (req, res) => {
  const { role, text, images, blocks, reasoning, trace, memories, context_tokens, context_window, turn_id, run_id } =
    req.body ?? {};
  if (role !== 'user' && role !== 'assistant') {
    res.status(400).json({ error: 'role must be user|assistant' });
    return;
  }
  const msg = await sessionRepository.addMessage(req.params.id, {
    role,
    text,
    images: Array.isArray(images) ? images.filter((s) => typeof s === 'string') : undefined,
    blocks,
    reasoning,
    trace,
    memories: Array.isArray(memories) ? memories : undefined,
    context_tokens: context_tokens !== undefined ? Number(context_tokens) : undefined,
    context_window: context_window !== undefined ? Number(context_window) : undefined,
    turn_id: typeof turn_id === 'string' ? turn_id : undefined,
    run_id: typeof run_id === 'string' ? run_id : undefined,
  });
  res.status(201).json(msg);
});
