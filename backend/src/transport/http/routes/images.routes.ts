import { Router } from 'express';
import { imageRepository } from '../../../domain/images/image.repository';
import { isolationRepository } from '../../../domain/isolations/isolation.repository';
import { dockerService } from '../../../isolation/docker.service';
import { buildManager } from '../../../isolation/build.manager';
import { imgImageName } from '../../../isolation/names';
import { assertRuntimes } from '../../../isolation/dockerfile.template';
import { createLogger } from '../../../config/logger';

const log = createLogger('images-routes');

/** CRUD + background build/lifecycle for standalone Docker image entities (`/api/images`). */
export const imagesRouter = Router();

/** Fields accepted on create/update (build options included). */
function pickImageFields(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'dockerfile', 'no_cache', 'pull'] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  // build_args: normalise to [{key,value}] and drop entries without a key.
  if (Array.isArray(body.build_args)) {
    patch.build_args = (body.build_args as Array<{ key?: unknown; value?: unknown }>)
      .map((a) => ({ key: String(a.key ?? '').trim(), value: String(a.value ?? '') }))
      .filter((a) => a.key);
  }
  return patch;
}

/** List all images, each annotated with its live build-job status (if a build ran this process). */
imagesRouter.get('/', async (_req, res) => {
  const images = await imageRepository.list();
  const jobs = new Map(buildManager.snapshots().map((s) => [s.image_id, s]));
  res.json(
    images.map((i) => {
      const id = String(i._id);
      return { ...i.toObject(), build_job: jobs.get(id) ?? null };
    }),
  );
});

/** Snapshots of every build job this process knows about (for the global builds overview). */
imagesRouter.get('/builds', (_req, res) => {
  res.json(buildManager.snapshots());
});

imagesRouter.get('/:id', async (req, res) => {
  const image = await imageRepository.findById(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(image);
});

/** Live docker state + Dockerfile lint warnings + which profiles reference this image. */
imagesRouter.get('/:id/status', async (req, res) => {
  const image = await imageRepository.findById(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(image._id);
  const [imageExists, profiles] = await Promise.all([
    dockerService.imageExists(imgImageName(id)),
    isolationRepository.listByImage(id),
  ]);
  const job = buildManager.jobFor(id);
  res.json({
    image_status: image.image_status,
    image_exists: imageExists,
    image_size: image.image_size,
    image_built_at: image.image_built_at,
    last_build_error: image.last_build_error,
    build_active: job?.status === 'queued' || job?.status === 'running',
    warnings: assertRuntimes(image.dockerfile ?? ''),
    referenced_by: profiles.map((p) => ({ _id: String(p._id), name: p.name })),
  });
});

imagesRouter.post('/', async (req, res) => {
  const fields = pickImageFields(req.body ?? {});
  if (!fields.name || typeof fields.name !== 'string' || !fields.name.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const image = await imageRepository.create(
      fields as unknown as Parameters<typeof imageRepository.create>[0],
    );
    res.status(201).json(image);
  } catch (err) {
    // Most likely a duplicate name (unique index).
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

imagesRouter.patch('/:id', async (req, res) => {
  const image = await imageRepository.findById(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const patch = pickImageFields(req.body ?? {});
  try {
    res.json(await imageRepository.update(String(image._id), patch));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Enqueue a background build. Returns 202 immediately; the caller attaches to `/:id/build/logs`
 * (SSE) to watch progress. Builds are serialised by `buildManager`, so a second image queues behind
 * the first. A build already queued/running for this image is a no-op.
 */
imagesRouter.post('/:id/build', async (req, res) => {
  const image = await imageRepository.findById(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await buildManager.enqueue(String(image._id));
  res.status(202).json({ status: 'queued' });
});

/**
 * SSE stream of a build's log. Reattaches to an in-flight (or just-finished) build: the buffered
 * log is replayed first, then live frames follow until the build reaches a terminal state. If no
 * build has ever run for this image in this process, the stream closes immediately.
 */
imagesRouter.get('/:id/build/logs', async (req, res) => {
  const image = await imageRepository.findById(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(image._id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const { active, detach } = buildManager.attach(id, (ev) => {
    if (ev.type === 'log') send('log', ev.chunk);
    else if (ev.type === 'done') {
      send('done', { status: 'built', size: ev.size });
      res.end();
    } else if (ev.type === 'error') {
      send('error', { message: ev.message });
      res.end();
    }
  });

  if (!active) {
    // Terminal frame was already replayed synchronously by attach(); close the stream.
    res.end();
    return;
  }
  req.on('close', detach);
});

/**
 * Delete an image. Refused with 409 while any isolation profile still references it (the operator
 * must unassign first) so we never silently break a profile. Otherwise removes the docker image
 * layers and the document.
 */
imagesRouter.delete('/:id', async (req, res) => {
  const image = await imageRepository.findById(req.params.id);
  if (!image) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const id = String(image._id);
  const refs = await isolationRepository.listByImage(id);
  if (refs.length > 0) {
    res.status(409).json({
      error: 'image is in use',
      referenced_by: refs.map((p) => ({ _id: String(p._id), name: p.name })),
    });
    return;
  }
  await dockerService.removeImage(imgImageName(id)).catch((err) => {
    log.warn({ id, err: String(err) }, 'docker image remove failed (continuing)');
  });
  await imageRepository.delete(id);
  res.status(204).end();
});
