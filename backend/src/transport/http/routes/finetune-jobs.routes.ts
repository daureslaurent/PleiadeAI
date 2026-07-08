import { Router } from 'express';
import { Readable } from 'node:stream';
import { createLogger } from '../../../config/logger';
import { finetuneJobRepository } from '../../../domain/finetune-jobs/finetune-job.repository';
import { finetuneServerService } from '../../../domain/finetune-servers/finetune-server.service';

const log = createLogger('finetune-jobs-routes');

/** Tracked fine-tune jobs: durable status/metrics + a proxied download of the produced GGUF. */
export const finetuneJobsRouter = Router();

finetuneJobsRouter.get('/', async (req, res) => {
  const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
  res.json(await finetuneJobRepository.list(Number.isFinite(limit) ? limit : undefined));
});

finetuneJobsRouter.get('/:id', async (req, res) => {
  const job = await finetuneJobRepository.findById(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(job);
});

/**
 * Stream the produced GGUF through the backend, so the browser never needs the server's credential
 * (nor network reach to the GPU box). Multi-GB bodies are piped, never buffered.
 */
finetuneJobsRouter.get('/:id/model', async (req, res) => {
  const job = await finetuneJobRepository.findById(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (job.status !== 'done') {
    res.status(409).json({ error: 'model not ready', status: job.status });
    return;
  }

  try {
    const remote = await finetuneServerService.streamModel(job.server_id, job.remote_job_id);
    const filename = job.gguf_filename || `${job.run_name}.gguf`;
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    const len = remote.headers.get('content-length');
    if (len) res.setHeader('content-length', len);

    if (!remote.body) {
      res.status(502).json({ error: 'remote returned an empty body' });
      return;
    }
    // Convert the WHATWG stream from fetch into a Node stream and pipe it to the client.
    Readable.fromWeb(remote.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ jobId: req.params.id, err: detail }, 'model download failed');
    if (!res.headersSent) res.status(502).json({ error: 'model download failed', detail });
  }
});

finetuneJobsRouter.delete('/:id', async (req, res) => {
  const job = await finetuneJobRepository.delete(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});
