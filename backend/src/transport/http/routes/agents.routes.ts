import { Router } from 'express';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { imageRepository } from '../../../domain/images/image.repository';
import { isolationRepository } from '../../../domain/isolations/isolation.repository';
import { agentContainerManager } from '../../../isolation/AgentContainerManager';
import { agentContainerRouter } from './agent-container.routes';
import { suggestAgentIdentity } from '../../../domain/agents/identity-suggester';
import { createLogger } from '../../../config/logger';

const log = createLogger('agents-routes');

/** CRUD for agents + the editable KV parameter grid (Skill & Agent Matrix). */
export const agentsRouter = Router();

/** Per-agent container controls (the agent's isolation profile is assigned via PATCH). */
agentsRouter.use('/:id/container', agentContainerRouter);

agentsRouter.get('/', async (_req, res) => {
  // Annotate each agent with a computed `visual` capability so the workspace can gate the Desktop
  // panel button: true only when the agent's isolation profile references a `visual` image. Resolved
  // with three list queries + set membership (single-operator scale) rather than a join per agent.
  const [agents, images, isolations] = await Promise.all([
    agentRepository.list(),
    imageRepository.list(),
    isolationRepository.list(),
  ]);
  const visualImageIds = new Set(images.filter((i) => i.visual).map((i) => String(i._id)));
  const visualIsolationIds = new Set(
    isolations
      .filter((iso) => iso.image_id && visualImageIds.has(String(iso.image_id)))
      .map((iso) => String(iso._id)),
  );
  res.json(
    agents.map((a) => ({
      ...a.toObject(),
      visual: Boolean(a.isolation_id && visualIsolationIds.has(String(a.isolation_id))),
    })),
  );
});

/**
 * Suggest a visual identity (swatch hue + lucide icon) for an agent from its name + description.
 * Stateless — the agent need not exist yet, so the editor can call it while drafting. Always returns
 * a valid on-palette `{ color, icon }` (the suggester falls back to a default on any failure).
 */
agentsRouter.post('/suggest-identity', async (req, res) => {
  const { name = '', description = '' } = req.body ?? {};
  const identity = await suggestAgentIdentity(String(name), String(description));
  res.json(identity);
});

agentsRouter.get('/:id', async (req, res) => {
  const agent = await agentRepository.findById(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(agent);
});

agentsRouter.post('/', async (req, res) => {
  const agent = await agentRepository.create(req.body);
  res.status(201).json(agent);
});

agentsRouter.patch('/:id', async (req, res) => {
  // Detect isolation-assignment changes so we can drop a now-stale container (it must be recreated
  // under the new profile / volume mode on next use).
  const before = await agentRepository.findById(req.params.id);
  const body = req.body ?? {};
  // Normalise an empty/absent isolation to null (= "no isolation", runs on the backend).
  if ('isolation_id' in body && !body.isolation_id) body.isolation_id = null;
  // Same for the optional inference endpoint (empty → null = use the fleet default endpoint).
  if ('endpoint_id' in body && !body.endpoint_id) body.endpoint_id = null;

  const agent = await agentRepository.update(req.params.id, body);
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const isolationChanged =
    ('isolation_id' in body && String(before?.isolation_id ?? '') !== String(agent.isolation_id ?? '')) ||
    ('isolation_volume_mode' in body && before?.isolation_volume_mode !== agent.isolation_volume_mode);
  if (isolationChanged) {
    void agentContainerManager
      .removeAgentContainer(String(agent._id))
      .catch((err) => log.warn({ id: String(agent._id), err: String(err) }, 'stale container removal failed'));
  }

  res.json(agent);
});

/**
 * Replace the agent's AGENTS.md charter. Operator-only by construction: there is no tool behind this
 * route, so an agent cannot rewrite its own standing instructions (its writable doc is the notebook).
 */
agentsRouter.put('/:id/agents-md', async (req, res) => {
  const agent = await agentRepository.update(req.params.id, {
    agents_md: String(req.body?.content ?? ''),
  });
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(agent);
});

/** Replace the agent's notebook (mirrors the `update_notebook` tool, replace mode). */
agentsRouter.put('/:id/notebook', async (req, res) => {
  const agent = await agentRepository.setNotebook(req.params.id, String(req.body?.content ?? ''));
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(agent);
});

/** Set/update a single local KV parameter (mirrors the `set_agent_parameter` tool). */
agentsRouter.put('/:id/parameters/:key', async (req, res) => {
  const agent = await agentRepository.setParameter(
    req.params.id,
    req.params.key,
    String(req.body?.value ?? ''),
  );
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(agent);
});

agentsRouter.delete('/:id/parameters/:key', async (req, res) => {
  const agent = await agentRepository.removeParameter(req.params.id, req.params.key);
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(agent);
});

agentsRouter.delete('/:id', async (req, res) => {
  const agent = await agentRepository.delete(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Full teardown on delete: the agent's container + its individual workspace volume (the shared
  // image/volume belong to the isolation profile and are left intact). Best-effort — never block.
  void agentContainerManager
    .teardownAgent(String(agent._id), { removeVolume: true })
    .catch((err) => log.warn({ id: String(agent._id), err: String(err) }, 'isolation teardown on delete failed'));
  res.status(204).end();
});
