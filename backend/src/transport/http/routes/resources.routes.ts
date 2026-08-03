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

/** Media types a browser can play or show in place; everything else is offered as a download. */
const INLINE_MIME = /^(image|video|audio)\//;

/** Parse a single-range `Range: bytes=a-b` header against a known size. `null` → serve the whole file. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  // `bytes=-500` means the *last* 500 bytes, which players use to read a trailing index (an mp4's
  // moov atom when it wasn't written up front).
  if (!rawStart) {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream a resource's bytes.
 *
 * Range support is what makes a generated video usable: a player issues `HEAD`, then a series of
 * partial reads to seek. Serving 200-with-the-whole-file for every one of those means scrubbing
 * re-downloads the clip each time. Images and audio get the same treatment for free.
 *
 * Disposition follows the media type rather than the storage kind — a video is a blob in the resource
 * store, but forcing `attachment` on it would make the browser download instead of play. `?download=1`
 * asks for the attachment behaviour explicitly, which is what the Data tab's download button does.
 */
resourcesRouter.get('/:sessionId/:handle/content', async (req, res) => {
  const { sessionId, handle } = req.params;
  const doc = await resourceRepository.findByHandle(sessionId, handle);
  if (!doc) {
    res.status(404).json({ error: 'resource not found' });
    return;
  }

  const mime = doc.mime || 'application/octet-stream';
  const size = doc.size ?? 0;
  const name = (doc.filename || doc.handle).replace(/"/g, '');
  const forceDownload = req.query.download === '1';

  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${!forceDownload && INLINE_MIME.test(mime) ? 'inline' : 'attachment'}; filename="${name}"`,
  );

  // A player's first request is a HEAD: answer with the headers alone, no GridFS read.
  if (req.method === 'HEAD') {
    if (size) res.setHeader('Content-Length', String(size));
    res.status(200).end();
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (req.headers.range && !range && size > 0) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else if (size) {
    res.setHeader('Content-Length', String(size));
  }

  const stream = range
    ? resourceRepository.openDownloadRange(doc, range.start, range.end)
    : resourceRepository.openDownload(doc);
  stream.on('error', (err) => {
    log.warn({ err: err.message, sessionId, handle }, 'resource stream error');
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
});
