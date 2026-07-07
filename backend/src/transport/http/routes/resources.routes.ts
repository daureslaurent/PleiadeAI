import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { resourceRepository } from '../../../domain/resources/resource.repository';

const log = createLogger('resources-route');

/**
 * Session resources (images + binary blobs) surfaced in the workspace **Data** tab. Metadata is
 * listed by session; bytes are streamed out of GridFS for thumbnails and downloads. All behind
 * `requireAuth` (mounted in `index.ts`).
 */
export const resourcesRouter = Router();

/** List every resource in a session (metadata only), oldest first. */
resourcesRouter.get('/', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  const rows = await resourceRepository.listBySession(sessionId);
  res.json(
    rows.map((r) => ({
      handle: r.handle,
      kind: r.kind,
      mime: r.mime,
      size: r.size,
      filename: r.filename || undefined,
      source: r.source,
      agentId: r.agent_id,
      createdAt: r.created_at,
    })),
  );
});

/** Stream a resource's bytes — inline for image thumbnails, as an attachment for blob downloads. */
resourcesRouter.get('/:sessionId/:handle/content', async (req, res) => {
  const { sessionId, handle } = req.params;
  const doc = await resourceRepository.findByHandle(sessionId, handle);
  if (!doc) {
    res.status(404).json({ error: 'resource not found' });
    return;
  }
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  if (doc.size) res.setHeader('Content-Length', String(doc.size));
  if (doc.kind === 'blob') {
    const name = (doc.filename || doc.handle).replace(/"/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  }
  const stream = resourceRepository.openDownload(doc);
  stream.on('error', (err) => {
    log.warn({ err: err.message, sessionId, handle }, 'resource stream error');
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
});
