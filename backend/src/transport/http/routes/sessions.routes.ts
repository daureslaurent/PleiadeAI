import { Router } from 'express';
import { sessionRepository } from '../../../domain/sessions/session.repository';
import { agentRepository } from '../../../domain/agents/agent.repository';

/** CRUD for conversation sessions + their message history (backs the Workspace). */
export const sessionsRouter = Router();

/** List sessions for an agent: `GET /api/sessions?agentId=…`. */
sessionsRouter.get('/', async (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  if (!agentId) {
    res.status(400).json({ error: 'agentId query param required' });
    return;
  }
  res.json(await sessionRepository.listByAgent(agentId));
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
  const { role, text, blocks, reasoning, trace, context_tokens, context_window } = req.body ?? {};
  if (role !== 'user' && role !== 'assistant') {
    res.status(400).json({ error: 'role must be user|assistant' });
    return;
  }
  const msg = await sessionRepository.addMessage(req.params.id, {
    role,
    text,
    blocks,
    reasoning,
    trace,
    context_tokens: context_tokens !== undefined ? Number(context_tokens) : undefined,
    context_window: context_window !== undefined ? Number(context_window) : undefined,
  });
  res.status(201).json(msg);
});
