import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { env } from './config/env';
import { createLogger } from './config/logger';
import { jobStore } from './lib/job-store';
import { runJob, killActiveChildren } from './trainer';
import { getHardwareInfo, getUsageReport } from './lib/hardware';
import { buildFeasibilityTable, computePlan, DEFAULT_SEQ_LEN } from './lib/capability';
import { resolveModelSizeB } from './lib/model-size';
import type { CapabilityReport, TrainRequest } from './types';

const log = createLogger('server');

// --- Ensure the working directories exist before accepting traffic ---
for (const dir of [env.DATA_DIR, env.MODELS_DIR, env.RUNS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Auth: bearer FINETUNE_API_KEY on everything except /health ---
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!token || token !== env.FINETUNE_API_KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

// --- Multipart upload -> DATA_DIR/<uuid>.jsonl ---
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, env.DATA_DIR),
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.jsonl`),
  }),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.jsonl') ||
      file.mimetype === 'application/x-ndjson' ||
      file.mimetype === 'application/jsonl' ||
      file.mimetype === 'text/plain' ||
      file.mimetype === 'application/octet-stream';
    cb(null, ok);
  },
});

// --- Health (public) ---
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(requireApiKey);

// --- GET /hardware -> detected hardware + per-size feasibility table ---
app.get('/hardware', async (_req: Request, res: Response) => {
  const hardware = await getHardwareInfo();
  const report: CapabilityReport = {
    hardware,
    sizes: buildFeasibilityTable(hardware),
  };
  res.json(report);
});

// --- GET /usage -> live GPU/CPU/RAM utilization (polled by the UI) ---
app.get('/usage', async (_req: Request, res: Response) => {
  res.json(await getUsageReport());
});

/**
 * Validate that an uploaded file is line-delimited JSON with a `messages` array on a
 * sampled prefix (matches the OpenAI-chat export contract). Returns the line count.
 * Throws on the first malformed sampled line.
 */
async function validateJsonl(filePath: string): Promise<number> {
  const content = await fsp.readFile(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('dataset is empty');

  const sampleSize = Math.min(lines.length, 25);
  for (let i = 0; i < sampleSize; i++) {
    const raw = lines[i]!;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(`line ${i + 1} is not valid JSON`);
    }
    const messages = (obj as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error(`line ${i + 1} is missing a non-empty "messages" array`);
    }
  }
  return lines.length;
}

// --- POST /upload ---
app.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded (field name must be "file")' });
    return;
  }
  const filePath = req.file.path;
  try {
    const lineCount = await validateJsonl(filePath);
    const datasetId = path.basename(filePath, '.jsonl');
    log.info({ datasetId, lineCount }, 'dataset uploaded');
    res.status(201).json({ dataset_id: datasetId, path: filePath, line_count: lineCount });
  } catch (err) {
    await fsp.rm(filePath, { force: true });
    const message = err instanceof Error ? err.message : 'invalid dataset';
    res.status(400).json({ error: `invalid dataset: ${message}` });
  }
});

// --- POST /train ---
const TrainSchema = z.object({
  base_model: z.string().min(1),
  run_name: z.string().min(1).max(128),
  dataset_id: z.string().min(1),
  webhook_url: z.string().url().optional(),
  target_size_b: z.number().positive().max(2000).optional(),
  on_infeasible: z.enum(['auto_adjust', 'warn_proceed']).optional(),
  hyperparams: z
    .object({
      sequence_len: z.number().int().positive().optional(),
      micro_batch_size: z.number().int().positive().optional(),
      gradient_accumulation_steps: z.number().int().positive().optional(),
      num_epochs: z.number().positive().optional(),
      learning_rate: z.number().positive().optional(),
      lora_r: z.number().int().positive().optional(),
      lora_alpha: z.number().int().positive().optional(),
      lora_dropout: z.number().min(0).max(1).optional(),
      warmup_ratio: z.number().min(0).max(1).optional(),
      save_steps: z.number().int().positive().optional(),
      gguf_quant: z.string().optional(),
    })
    .strict()
    .optional(),
});

app.post('/train', async (req: Request, res: Response) => {
  const parsed = TrainSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid request', issues: parsed.error.issues });
    return;
  }
  const body = parsed.data;

  // Resolve dataset_id back to a file inside DATA_DIR (guard against path traversal).
  const datasetPath = path.join(env.DATA_DIR, `${path.basename(body.dataset_id)}.jsonl`);
  if (!datasetPath.startsWith(path.resolve(env.DATA_DIR)) || !fs.existsSync(datasetPath)) {
    res.status(404).json({ error: `dataset_id not found: ${body.dataset_id}` });
    return;
  }

  // --- Pre-flight capacity planning ---
  let size;
  try {
    size = await resolveModelSizeB(body.base_model, body.target_size_b);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const policy = body.on_infeasible ?? 'auto_adjust';
  const hardware = await getHardwareInfo();
  const plan = computePlan(hardware, {
    sizeB: size.size_b,
    sizeSource: size.source,
    requestedSeqLen: body.hyperparams?.sequence_len ?? DEFAULT_SEQ_LEN,
    microBatch: body.hyperparams?.micro_batch_size ?? 1,
    gradAccum: body.hyperparams?.gradient_accumulation_steps ?? 8,
    policy,
  });

  // auto_adjust rejects only when nothing fits; warn_proceed always starts.
  if (plan.feasibility === 'no' && policy === 'auto_adjust') {
    res.status(422).json({
      error: `model does not fit the hardware; ~${plan.est_per_gpu_vram_gb}GB/GPU needed vs ${plan.usable_per_gpu_vram_gb}GB usable`,
      plan,
    });
    return;
  }

  const req2: TrainRequest = { ...body, dataset_id: body.dataset_id };
  const job = jobStore.create(req2, datasetPath, plan);
  jobStore.enqueue(job.id, () => runJob(job.id));

  log.info(
    { jobId: job.id, runName: job.run_name, sizeB: plan.size_b, strategy: plan.strategy, feasibility: plan.feasibility },
    'training job accepted',
  );
  res.status(202).json({ job_id: job.id, status: job.phase, plan });
});

// --- GET /jobs/:id ---
app.get('/jobs/:id', (req: Request, res: Response) => {
  const job = jobStore.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json(jobStore.toStatus(job));
});

// --- GET /jobs/:id/model -> stream the GGUF ---
app.get('/jobs/:id/model', (req: Request, res: Response) => {
  const job = jobStore.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (job.phase !== 'done' || !job.artifact_path || !fs.existsSync(job.artifact_path)) {
    res.status(404).json({ error: 'model not ready', status: job.phase });
    return;
  }
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader(
    'content-disposition',
    `attachment; filename="${job.gguf_filename ?? path.basename(job.artifact_path)}"`,
  );
  const stream = fs.createReadStream(job.artifact_path);
  stream.on('error', (err) => {
    log.error({ err, jobId: job.id }, 'error streaming model');
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
});

// --- Multer / generic error handler ---
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: `upload error: ${err.message}` });
    return;
  }
  log.error({ err }, 'unhandled request error');
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(env.FINETUNE_PORT, () => {
  log.info({ port: env.FINETUNE_PORT }, 'finetune service listening');
});

// --- Graceful shutdown: stop accepting, kill any in-flight training child ---
function shutdown(signal: string): void {
  log.warn({ signal }, 'shutting down');
  killActiveChildren();
  server.close(() => process.exit(0));
  // Hard exit if the server refuses to close within 10s.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
