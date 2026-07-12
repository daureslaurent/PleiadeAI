import { Router } from 'express';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { qdrantService } from '../../../domain/memory/qdrant.service';

/**
 * Memory Vault inspector. Reads/deletes are always scoped to one agent's isolated Qdrant
 * namespace — the namespace is resolved from the agent doc, never accepted from the client,
 * preserving strict per-agent isolation.
 */
export const memoryRouter = Router();

async function namespaceFor(agentId: string): Promise<string | null> {
  const agent = await agentRepository.findById(agentId);
  return agent ? agent.qdrant_namespace : null;
}

memoryRouter.get('/:agentId', async (req, res) => {
  const namespace = await namespaceFor(req.params.agentId);
  if (!namespace) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  res.json(await qdrantService.list(namespace));
});

/**
 * Wipe the agent's whole memory. Deliberately server-side: the listing is paged, so a client-driven
 * "delete every id I can see" would leave everything past the first page behind and *look* like it
 * worked. Still namespace-scoped — one agent's erase can never touch another's.
 */
memoryRouter.delete('/:agentId/all', async (req, res) => {
  const namespace = await namespaceFor(req.params.agentId);
  if (!namespace) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const deleted = await qdrantService.clearNamespace(namespace);
  res.json({ ok: true, deleted });
});

memoryRouter.delete('/:agentId/points', async (req, res) => {
  const namespace = await namespaceFor(req.params.agentId);
  if (!namespace) {
    res.status(404).json({ error: 'agent not found' });
    return;
  }
  const ids: Array<string | number> = req.body?.ids ?? [];
  await qdrantService.deletePoints(namespace, ids);
  res.json({ ok: true, deleted: ids.length });
});
