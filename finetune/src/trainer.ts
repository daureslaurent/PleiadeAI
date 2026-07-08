import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Job, WebhookPayload } from './types';
import { env } from './config/env';
import { createLogger } from './config/logger';
import { jobStore } from './lib/job-store';
import { buildAxolotlConfig, mergedModelDir } from './lib/axolotl-config';
import { deliverWebhook } from './lib/webhook';

const log = createLogger('trainer');

/** Track the live child per job so shutdown / cancellation can kill it. */
const activeChildren = new Map<string, ChildProcess>();

/**
 * Orchestrates one job end-to-end:
 *   preparing -> training (accelerate + DeepSpeed) -> exporting (merge + GGUF) -> done|failed
 * On any failure the job is marked failed and (if a webhook was given) a failure payload is sent.
 * The run directory is preserved on failure for debugging.
 */
export async function runJob(jobId: string): Promise<void> {
  const job = jobStore.get(jobId);
  if (!job) {
    log.error({ jobId }, 'runJob: unknown job');
    return;
  }

  const runDir = path.join(env.RUNS_DIR, job.id);
  const outputDir = path.join(runDir, 'out');
  const configPath = path.join(runDir, 'config.yml');

  try {
    // --- 1. Prepare: generate config.yml ---
    await fsp.mkdir(outputDir, { recursive: true });
    const yaml = buildAxolotlConfig({
      baseModel: job.base_model,
      datasetPath: job.dataset_path,
      outputDir,
      hyperparams: job.hyperparams,
      plan: job.plan,
    });
    await fsp.writeFile(configPath, yaml, 'utf8');
    log.info({ jobId, configPath }, 'wrote axolotl config');

    // --- 2. Train ---
    jobStore.setPhase(jobId, 'training');
    await runTraining(job, configPath);

    // --- 3. Merge adapter + export GGUF ---
    jobStore.setPhase(jobId, 'exporting');
    const ggufPath = await runExport(job, configPath, outputDir);

    jobStore.markDone(jobId, ggufPath, path.basename(ggufPath));
    await notify(job, 'done', path.basename(ggufPath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, 'job failed');
    jobStore.markFailed(jobId, message);
    await notify(job, 'failed');
  } finally {
    activeChildren.delete(jobId);
  }
}

/**
 * Spawn `accelerate launch -m axolotl.cli.train <config>` across all GPUs. stdout/stderr
 * are streamed line-by-line to Pino and the job's log tail; training progress is parsed
 * best-effort. Rejects on non-zero exit.
 */
function runTraining(job: Job, configPath: string): Promise<void> {
  const args = [
    'launch',
    '--num_processes',
    String(env.NUM_GPUS),
    '--multi_gpu',
    '-m',
    'axolotl.cli.train',
    configPath,
  ];

  const usingFsdp = job.plan.strategy === 'fsdp_qlora';

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Enable exactly one accelerate plugin, matching the strategy baked into the config.yml.
    ...(usingFsdp ? { ACCELERATE_USE_FSDP: 'true' } : { ACCELERATE_USE_DEEPSPEED: 'true' }),
    // Expose exactly NUM_GPUS devices unless the operator pinned specific ones already.
    ...(process.env.CUDA_VISIBLE_DEVICES
      ? {}
      : {
          CUDA_VISIBLE_DEVICES: Array.from({ length: env.NUM_GPUS }, (_, i) => i).join(','),
        }),
    ...(env.HF_TOKEN ? { HF_TOKEN: env.HF_TOKEN, HUGGING_FACE_HUB_TOKEN: env.HF_TOKEN } : {}),
  };

  return runSpawn(job, 'accelerate', args, childEnv, (line) => parseProgress(job, line));
}

/**
 * Merge the QLoRA adapter into the base weights, then convert the merged HF model to a
 * quantized GGUF using the bundled llama.cpp tooling.
 *
 * We deliberately use llama.cpp's `convert_hf_to_gguf.py` + `llama-quantize` rather than
 * Axolotl's version-sensitive `--export_quant_gguf`, so the export path is deterministic
 * across Axolotl bumps (see plan Risk #1). Returns the absolute path of the final GGUF.
 */
async function runExport(job: Job, configPath: string, outputDir: string): Promise<string> {
  const merged = mergedModelDir(outputDir);

  // 3a. Merge adapter -> full HF model dir.
  await runSpawn(job, 'python3', [
    '-m',
    'axolotl.cli.merge_lora',
    configPath,
    `--lora_model_dir=${outputDir}`,
    `--output_dir=${merged}`,
  ]);

  await fsp.mkdir(env.MODELS_DIR, { recursive: true });

  const quant = (job.hyperparams.gguf_quant ?? env.GGUF_QUANT).toLowerCase();
  const f16Path = path.join(outputDir, `${job.run_name}-f16.gguf`);
  const finalName = `${sanitize(job.run_name)}-${job.id}.${quant}.gguf`;
  const finalPath = path.join(env.MODELS_DIR, finalName);

  // 3b. Convert merged HF model -> f16 GGUF.
  const convertScript = path.join(env.LLAMACPP_DIR, 'convert_hf_to_gguf.py');
  await runSpawn(job, 'python3', [
    convertScript,
    merged,
    '--outfile',
    f16Path,
    '--outtype',
    'f16',
  ]);

  // 3c. Quantize f16 GGUF -> requested quant.
  const quantizeBin = path.join(env.LLAMACPP_DIR, 'build', 'bin', 'llama-quantize');
  await runSpawn(job, quantizeBin, [f16Path, finalPath, quant]);

  // Drop the large intermediate f16 artifact.
  await fsp.rm(f16Path, { force: true });

  log.info({ jobId: job.id, finalPath }, 'GGUF export complete');
  return finalPath;
}

/**
 * Generic spawn wrapper: pipes stdout+stderr line-by-line to Pino and the job log tail,
 * tracks the child for shutdown, and resolves/rejects on exit code.
 */
function runSpawn(
  job: Job,
  command: string,
  args: string[],
  childEnv: NodeJS.ProcessEnv = process.env,
  onLine?: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    log.info({ jobId: job.id, command, args }, 'spawn');
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.set(job.id, child);

    const pipe = (stream: NodeJS.ReadableStream, level: 'info' | 'warn') => {
      const rl = createInterface({ input: stream });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        log[level]({ jobId: job.id }, line);
        jobStore.appendLog(job.id, line);
        onLine?.(line);
      });
    };
    if (child.stdout) pipe(child.stdout, 'info');
    if (child.stderr) pipe(child.stderr, 'warn'); // most ML tooling logs to stderr

    child.on('error', (err) => {
      reject(new Error(`failed to spawn ${command}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? 'null'} (signal ${signal ?? 'none'})`));
      }
    });
  });
}

/**
 * Best-effort progress + metric parsing from HF/Axolotl log lines.
 *
 * The HF Trainer prints python dicts like
 *   {'loss': 1.23, 'grad_norm': 0.9, 'learning_rate': 0.0002, 'epoch': 0.42}
 * (single-quoted, sometimes with a `global_step`/`step` key). We capture loss/lr/epoch into the
 * job's metric series for the UI loss curve, and derive coarse progress from `epoch` or tqdm bars.
 *
 * This is intentionally defensive — log formats vary across Axolotl/transformers versions, so a
 * miss just means no datapoint, never a crash or a failed run.
 */
function parseProgress(job: Job, line: string): void {
  const num = (key: string): number | undefined => {
    const m = line.match(new RegExp(`['"]${key}['"]\\s*:\\s*(-?[0-9.eE+-]+)`));
    if (!m?.[1]) return undefined;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : undefined;
  };

  const loss = num('loss');
  const epoch = num('epoch');

  // A line carrying a loss is a training datapoint → record it for the curve.
  if (loss !== undefined) {
    jobStore.appendMetric(job.id, {
      step: num('global_step') ?? num('step') ?? 0,
      loss,
      epoch,
      lr: num('learning_rate') ?? num('lr'),
    });
  }

  if (epoch !== undefined) {
    const totalEpochs = job.hyperparams.num_epochs ?? 3;
    if (totalEpochs > 0) jobStore.setProgress(job.id, epoch / totalEpochs);
    return;
  }

  // tqdm-style progress bars: " 37%|███"
  const pctMatch = line.match(/\b(\d{1,3})%\|/);
  if (pctMatch?.[1]) {
    jobStore.setProgress(job.id, Number(pctMatch[1]) / 100);
  }
}

async function notify(
  job: Job,
  status: 'done' | 'failed',
  ggufFilename?: string,
): Promise<void> {
  if (!job.webhook_url) return;
  const payload: WebhookPayload = {
    job_id: job.id,
    run_name: job.run_name,
    status,
    base_model: job.base_model,
    gguf_filename: ggufFilename,
    download_url: ggufFilename ? `/jobs/${job.id}/model` : undefined,
    error: status === 'failed' ? job.error : undefined,
  };
  await deliverWebhook(job.webhook_url, payload);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Kill any in-flight child on graceful shutdown. Exposed for the SIGTERM handler. */
export function killActiveChildren(): void {
  for (const [jobId, child] of activeChildren) {
    log.warn({ jobId }, 'terminating active child on shutdown');
    child.kill('SIGTERM');
  }
}

/** Exposed so callers can guard the download endpoint against path traversal. */
export function isFileReadable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
