import { Router } from 'express';
import { apiKeyRepository } from '../../../domain/api-keys/api-key.repository';
import { apiKeyService } from '../../../domain/api-keys/api-key.service';
import type { ApiKeyDoc } from '../../../domain/api-keys/api-key.model';

/**
 * Management of read-only API keys. Mounted behind `requireAuth` **and** `requireOperator`: a key
 * can never list, mint or revoke keys, so leaking one doesn't compound.
 */
export const apiKeysRouter = Router();

/** Public projection. `key_hash` is `select: false`; the plaintext exists only in the POST response. */
function shape(key: ApiKeyDoc) {
  return {
    _id: key._id,
    name: key.name,
    prefix: key.prefix,
    last_used_at: key.last_used_at,
    revoked_at: key.revoked_at,
    created_at: (key as unknown as { created_at?: Date }).created_at,
  };
}

apiKeysRouter.get('/', async (_req, res) => {
  const keys = await apiKeyRepository.list();
  res.json(keys.map(shape));
});

/**
 * Mint a key. The plaintext is returned **once, here** — it is sha256'd at rest and cannot be
 * recovered. The client is responsible for showing it to the operator before navigating away.
 */
apiKeysRouter.post('/', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const { doc, plaintext } = await apiKeyService.issue(name);
  res.status(201).json({ ...shape(doc), key: plaintext });
});

/** Revoke: the key stops authenticating immediately, but its row survives for audit. */
apiKeysRouter.post('/:id/revoke', async (req, res) => {
  const key = await apiKeyRepository.revoke(req.params.id);
  if (!key) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  apiKeyService.forget(String(key._id));
  res.json(shape(key));
});

/** Hard delete — drops the audit row too. Revoke is the safer default. */
apiKeysRouter.delete('/:id', async (req, res) => {
  const key = await apiKeyRepository.delete(req.params.id);
  if (!key) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  apiKeyService.forget(String(key._id));
  res.status(204).end();
});
