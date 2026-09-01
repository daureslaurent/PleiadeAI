import { Router } from 'express';
import { autoLoopRunner } from '../../../autonomy/AutoLoopRunner';
import { autoLoopRepository } from '../../../domain/auto-loops/auto-loop.repository';
import { sessionRepository } from '../../../domain/sessions/session.repository';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { todoRepository } from '../../../domain/todos/todo.repository';

/** CRUD for conversation sessions + their message history (backs the Workspace). */
export const sessionsRouter = Router();

/**
 * List sessions for an agent: `GET /api/sessions?agentId=…&origin=user|synthetic|all[&limit=&skip=]`.
 * `origin` defaults to `user` — the Workspace shows the operator's own chats, not the (potentially
 * thousands of) conversations produced by the Conversation Generator.
 *
 * Passing `limit` switches the response to the paged shape `{ sessions, total }`: the Workspace
 * navigator shows a handful of recent conversations per agent and pages the rest in on demand, and
 * it needs the unwindowed total to say how many are still hidden. Without `limit` the response stays
 * the bare array every other consumer already expects.
 */
sessionsRouter.get('/', async (req, res) => {
  const agentId = req.query.agentId as string | undefined;
  if (!agentId) {
    res.status(400).json({ error: 'agentId query param required' });
    return;
  }
  const raw = req.query.origin;
  const origin = raw === 'synthetic' || raw === 'all' ? raw : 'user';

  const limit = Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    res.json(await sessionRepository.listByAgent(agentId, origin));
    return;
  }
  const skip = Math.max(0, Number(req.query.skip) || 0);
  // Capped so a hand-rolled `?limit=100000` can't be used to dump the whole collection in one call.
  const [sessions, total] = await Promise.all([
    sessionRepository.listByAgent(agentId, origin, { limit: Math.min(200, limit), skip }),
    sessionRepository.countByAgent(agentId, origin),
  ]);
  res.json({ sessions, total });
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

/**
 * One session by id. Needed to deep-link a conversation (`/workspace?session=…`) — the forum's
 * mention Run lands the operator here and the page has to resolve which agent owns it before it can
 * open the chat.
 */
sessionsRouter.get('/:id', async (req, res) => {
  const session = await sessionRepository.findById(req.params.id).catch(() => null);
  if (!session) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(session);
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
  // A self-driving conversation keeps a timer in this process (AUTO_AGENT_PLAN.md §4). Deleting the
  // session without disarming it would leave the loop ticking against a history that no longer
  // exists — turns written into a void, once per interval, until the next restart.
  autoLoopRunner.forget(req.params.id);
  await autoLoopRepository.removeBySession(req.params.id);
  res.status(204).end();
});

/**
 * Every agent's task list in this session (`todowrite`). Read on session load so a reload — or a
 * refresh mid-turn — restores the pinned checklist instead of blanking it until the next write.
 */
sessionsRouter.get('/:id/todos', async (req, res) => {
  const lists = await todoRepository.listBySession(req.params.id);
  res.json(
    lists.map((l) => ({
      agentId: l.agent_id,
      agent: l.agent_name,
      items: l.items,
      updatedAt: l.updated_at,
    })),
  );
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
