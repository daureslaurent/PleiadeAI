import { Router } from 'express';
import multer from 'multer';
import { createLogger } from '../../../config/logger';
import { encryptSecret } from '../../../isolation/ssh.service';
import { finetuneServerRepository } from '../../../domain/finetune-servers/finetune-server.repository';
import {
  FinetuneServerError,
  finetuneServerService,
} from '../../../domain/finetune-servers/finetune-server.service';
import { finetuneJobRepository } from '../../../domain/finetune-jobs/finetune-job.repository';
import { exportService } from '../../../domain/scoring/export.service';
import { conversationScoreRepository } from '../../../domain/scoring/conversation-score.repository';
import type { FinetuneServerDoc } from '../../../domain/finetune-servers/finetune-server.model';

const log = createLogger('finetune-servers-routes');

/** Manual dataset uploads are held in memory then streamed straight through to the remote server. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2048 * 1024 * 1024 }, // mirror the remote's MAX_UPLOAD_MB default
});

/** CRUD for remote fine-tune servers + authenticated proxies to each server's API. */
export const finetuneServersRouter = Router();

/**
 * Public projection. `api_key_enc` is `select: false` so it is normally absent, but we strip it
 * defensively and expose only whether a key is configured — the secret never reaches the client.
 */
function shape(server: FinetuneServerDoc) {
  return {
    _id: server._id,
    name: server.name,
    base_url: server.base_url,
    enabled: server.enabled,
    has_api_key: Boolean(server.api_key_enc),
    created_at: (server as unknown as { created_at?: Date }).created_at,
    updated_at: (server as unknown as { updated_at?: Date }).updated_at,
  };
}

/**
 * Map a remote-call failure to an HTTP response, mirroring `endpoints.routes.ts` `/discover`.
 *
 * A remote **4xx** is a client-actionable answer (bad model id, unfittable size, missing dataset),
 * so we pass its status through with the server's own explanation rather than masking it as a
 * gateway failure. Anything else — timeouts, connection refused, remote 5xx — is a genuine 502.
 */
function sendRemoteError(res: Parameters<Parameters<typeof finetuneServersRouter.get>[1]>[1], err: unknown, what: string) {
  const detail = err instanceof Error ? err.message : String(err);
  const remote = err instanceof FinetuneServerError ? err.status : undefined;
  const status = remote && remote >= 400 && remote < 500 ? remote : 502;
  log.warn({ err: detail, remoteStatus: remote }, `${what} failed`);
  res.status(status).json({ error: `${what} failed`, detail });
}

// --- CRUD ---

finetuneServersRouter.get('/', async (_req, res) => {
  const servers = await finetuneServerRepository.list();
  res.json(servers.map(shape));
});

finetuneServersRouter.post('/', async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.name !== 'string' || !b.name.trim() || typeof b.base_url !== 'string' || !b.base_url.trim()) {
    res.status(400).json({ error: 'name and base_url are required' });
    return;
  }
  const server = await finetuneServerRepository.create({
    name: b.name.trim(),
    base_url: b.base_url.trim().replace(/\/+$/, ''),
    api_key_enc: typeof b.api_key === 'string' && b.api_key ? encryptSecret(b.api_key) : null,
    enabled: b.enabled !== undefined ? Boolean(b.enabled) : true,
  });
  res.status(201).json(shape(server));
});

finetuneServersRouter.patch('/:id', async (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
  if (typeof b.base_url === 'string' && b.base_url.trim()) patch.base_url = b.base_url.trim().replace(/\/+$/, '');
  // An empty-string api_key explicitly clears the stored credential; omitting the field leaves it.
  if (typeof b.api_key === 'string') patch.api_key_enc = b.api_key ? encryptSecret(b.api_key) : null;
  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);

  const server = await finetuneServerRepository.update(req.params.id, patch);
  if (!server) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(shape(server));
});

finetuneServersRouter.delete('/:id', async (req, res) => {
  const server = await finetuneServerRepository.delete(req.params.id);
  if (!server) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.status(204).end();
});

// --- Proxies to the remote fine-tune service ---

/** Liveness + the remote service's build version (shown on the Fine-Tuning page). */
finetuneServersRouter.get('/:id/health', async (req, res) => {
  try {
    res.json(await finetuneServerService.getHealth(req.params.id));
  } catch (err) {
    sendRemoteError(res, err, 'health check');
  }
});

/** Static hardware + per-model-size feasibility table. */
finetuneServersRouter.get('/:id/hardware', async (req, res) => {
  try {
    res.json(await finetuneServerService.getHardware(req.params.id));
  } catch (err) {
    sendRemoteError(res, err, 'hardware fetch');
  }
});

/** Live GPU/CPU/RAM utilization. Polled by the Fine-Tuning page while it's open. */
finetuneServersRouter.get('/:id/usage', async (req, res) => {
  try {
    res.json(await finetuneServerService.getUsage(req.params.id));
  } catch (err) {
    sendRemoteError(res, err, 'usage fetch');
  }
});

/** Passthrough for a manually-uploaded JSONL dataset → returns the remote `dataset_id`. */
finetuneServersRouter.post('/:id/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded (field name must be "file")' });
    return;
  }
  try {
    const result = await finetuneServerService.uploadDataset(
      String(req.params.id),
      req.file.buffer,
      req.file.originalname || 'training_data.jsonl',
    );
    res.status(201).json(result);
  } catch (err) {
    sendRemoteError(res, err, 'dataset upload');
  }
});

/**
 * Start a training run.
 *
 * Body: `{ run_name, base_model, target_size_b?, on_infeasible?, hyperparams?,
 *          dataset: { source: 'scored'|'manual', filter?: {minScore?,tags?}, dataset_id? } }`
 *
 * For `source: 'scored'` we build the curated JSONL from the app's own judged archive and upload it
 * to the server first. For `'manual'` the caller has already POSTed to `/:id/upload`. Either way we
 * then kick off `/train`, persist a durable `finetune_jobs` doc, and hand the server's fitted `plan`
 * back to the UI as its recommendation.
 */
finetuneServersRouter.post('/:id/train', async (req, res) => {
  const b = req.body ?? {};
  const serverId = req.params.id;

  if (typeof b.run_name !== 'string' || !b.run_name.trim()) {
    res.status(400).json({ error: 'run_name is required' });
    return;
  }
  if (typeof b.base_model !== 'string' || !b.base_model.trim()) {
    res.status(400).json({ error: 'base_model is required' });
    return;
  }
  const dataset = b.dataset ?? {};
  if (dataset.source !== 'scored' && dataset.source !== 'manual') {
    res.status(400).json({ error: "dataset.source must be 'scored' or 'manual'" });
    return;
  }

  const server = await finetuneServerRepository.findById(serverId);
  if (!server) {
    res.status(404).json({ error: 'fine-tune server not found' });
    return;
  }

  try {
    let datasetId: string;
    let datasetStats: Record<string, unknown>;

    if (dataset.source === 'scored') {
      const filter = {
        minScore: typeof dataset.filter?.minScore === 'number' ? dataset.filter.minScore : undefined,
        tags: Array.isArray(dataset.filter?.tags) ? dataset.filter.tags : undefined,
      };
      const { body, turns } = await exportService.buildJsonl(filter);
      if (turns === 0) {
        res.status(422).json({ error: 'no training examples match that quality filter' });
        return;
      }
      const uploaded = await finetuneServerService.uploadDataset(
        serverId,
        Buffer.from(body, 'utf8'),
        `sft-${Date.now()}.jsonl`,
      );
      datasetId = uploaded.dataset_id;
      datasetStats = { examples: turns, filter, summary: await conversationScoreRepository.summary() };
    } else {
      if (typeof dataset.dataset_id !== 'string' || !dataset.dataset_id) {
        res.status(400).json({ error: "dataset.dataset_id is required when source is 'manual'" });
        return;
      }
      datasetId = dataset.dataset_id;
      datasetStats = { source: 'manual', dataset_id: datasetId };
    }

    const started = await finetuneServerService.startTrain(serverId, {
      base_model: b.base_model.trim(),
      run_name: b.run_name.trim(),
      dataset_id: datasetId,
      target_size_b: typeof b.target_size_b === 'number' ? b.target_size_b : undefined,
      on_infeasible: b.on_infeasible === 'warn_proceed' ? 'warn_proceed' : 'auto_adjust',
      hyperparams: typeof b.hyperparams === 'object' && b.hyperparams ? b.hyperparams : undefined,
    });

    const job = await finetuneJobRepository.create({
      server_id: server._id,
      remote_job_id: started.job_id,
      run_name: b.run_name.trim(),
      base_model: b.base_model.trim(),
      size_b: started.plan?.size_b ?? null,
      strategy: started.plan?.strategy ?? '',
      plan: started.plan,
      dataset_source: dataset.source,
      dataset_stats: datasetStats,
      status: 'queued',
    });

    log.info({ jobId: String(job._id), remoteJobId: started.job_id, serverId }, 'fine-tune job started');
    res.status(202).json({ job_id: String(job._id), remote_job_id: started.job_id, plan: started.plan });
  } catch (err) {
    // Remote 4xx (e.g. 422 "won't fit" under auto_adjust, 400 "size unknown") passes through with
    // the server's own explanation; only real gateway failures become 502.
    sendRemoteError(res, err, 'train start');
  }
});
