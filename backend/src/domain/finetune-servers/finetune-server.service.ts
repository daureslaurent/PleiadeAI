import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { decryptSecret } from '../../isolation/ssh.service';
import { finetuneServerRepository } from './finetune-server.repository';
import type { FinetuneServerDoc } from './finetune-server.model';

const log = createLogger('finetune-server-service');

/** Fast calls (status/telemetry/capability). */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Dataset upload + train kickoff can be slow (large JSONL bodies). */
const UPLOAD_TIMEOUT_MS = 300_000;

/** Thrown when the remote fine-tune server is unreachable or answers non-2xx. Routes map this to 502. */
export class FinetuneServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FinetuneServerError';
  }
}

// --- Remote response shapes (mirror of finetune/src/types.ts) ---

export interface GpuUsage {
  index: number;
  name: string;
  util_pct: number;
  vram_used_mb: number;
  vram_total_mb: number;
  temp_c: number | null;
  power_w: number | null;
}

export interface UsageReport {
  gpus: GpuUsage[];
  cpu: { cores: number; load_avg: [number, number, number]; load_pct: number };
  ram: { used_mb: number; total_mb: number };
  at: string;
  note?: string;
}

export interface FeasibilityEntry {
  size_b: number;
  feasibility: 'ok' | 'tight' | 'no';
  strategy: 'deepspeed_zero2' | 'fsdp_qlora' | null;
  max_sequence_len: number | null;
  note: string;
}

export interface CapabilityReport {
  hardware: {
    gpus: { index: number; name: string; vram_total_mb: number; vram_free_mb: number }[];
    gpu_count: number;
    min_gpu_vram_mb: number | null;
    total_gpu_vram_mb: number;
    cpu: { model: string; cores: number };
    ram: { total_mb: number; free_mb: number };
    detected_at: string;
    note?: string;
  };
  sizes: FeasibilityEntry[];
}

export interface TrainingPlan {
  size_b: number;
  size_source: string;
  strategy: 'deepspeed_zero2' | 'fsdp_qlora';
  sequence_len: number;
  micro_batch_size: number;
  gradient_accumulation_steps: number;
  feasibility: 'ok' | 'tight' | 'no';
  est_per_gpu_vram_gb: number;
  usable_per_gpu_vram_gb: number;
  adjustments: string[];
  warnings: string[];
}

export interface TrainMetric {
  step: number;
  loss: number;
  epoch?: number;
  lr?: number;
  at: string;
}

export interface RemoteJobStatus {
  job_id: string;
  run_name: string;
  base_model: string;
  status: 'queued' | 'preparing' | 'training' | 'exporting' | 'done' | 'failed';
  progress: number;
  plan: TrainingPlan;
  gguf_filename?: string;
  error?: string;
  log_tail: string[];
  metrics: TrainMetric[];
  created_at: string;
  updated_at: string;
}

export interface StartTrainPayload {
  base_model: string;
  run_name: string;
  dataset_id: string;
  target_size_b?: number;
  on_infeasible?: 'auto_adjust' | 'warn_proceed';
  hyperparams?: Record<string, unknown>;
}

/** Resolve a server + its decrypted bearer token. Throws if missing / undecryptable. */
async function resolve(id: string | Types.ObjectId): Promise<{ server: FinetuneServerDoc; apiKey: string }> {
  const server = await finetuneServerRepository.findByIdWithKey(id);
  if (!server) throw new FinetuneServerError('fine-tune server not found', 404);

  let apiKey = '';
  if (server.api_key_enc) {
    try {
      apiKey = decryptSecret(server.api_key_enc);
    } catch (err) {
      // A key that won't decrypt (rotated ISOLATION_ENC_KEY/JWT_SECRET) must not silently
      // become an unauthenticated call — surface it.
      log.error({ serverId: String(server._id), err: String(err) }, 'failed to decrypt api key');
      throw new FinetuneServerError('stored api_key could not be decrypted (was the encryption key rotated?)');
    }
  }
  return { server, apiKey };
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function baseUrl(server: FinetuneServerDoc): string {
  return server.base_url.replace(/\/+$/, '');
}

/** `fetch` with a hard timeout; non-2xx and network errors both become {@link FinetuneServerError}. */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new FinetuneServerError(
        `remote responded ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
        res.status,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof FinetuneServerError) throw err;
    const reason = err instanceof Error && err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(err);
    throw new FinetuneServerError(`request to ${url} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Proxy to the remote fine-tune microservice. Every method throws {@link FinetuneServerError} on failure. */
export const finetuneServerService = {
  /** Static hardware + per-size feasibility table (`GET /hardware`). */
  async getHardware(id: string | Types.ObjectId): Promise<CapabilityReport> {
    const { server, apiKey } = await resolve(id);
    const res = await request(`${baseUrl(server)}/hardware`, { headers: authHeaders(apiKey) });
    return (await res.json()) as CapabilityReport;
  },

  /** Live GPU/CPU/RAM utilization (`GET /usage`). Polled by the UI while the page is open. */
  async getUsage(id: string | Types.ObjectId): Promise<UsageReport> {
    const { server, apiKey } = await resolve(id);
    const res = await request(`${baseUrl(server)}/usage`, { headers: authHeaders(apiKey) });
    return (await res.json()) as UsageReport;
  },

  /** Upload a JSONL dataset (`POST /upload`, multipart). Returns the remote `dataset_id`. */
  async uploadDataset(
    id: string | Types.ObjectId,
    body: Buffer,
    filename = 'training_data.jsonl',
  ): Promise<{ dataset_id: string; line_count: number }> {
    const { server, apiKey } = await resolve(id);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: 'application/x-ndjson' }), filename);
    const res = await request(
      `${baseUrl(server)}/upload`,
      { method: 'POST', headers: authHeaders(apiKey), body: form },
      UPLOAD_TIMEOUT_MS,
    );
    return (await res.json()) as { dataset_id: string; line_count: number };
  },

  /** Kick off training (`POST /train`). Returns the remote job id + the fitted plan (recommendation). */
  async startTrain(
    id: string | Types.ObjectId,
    payload: StartTrainPayload,
  ): Promise<{ job_id: string; status: string; plan: TrainingPlan }> {
    const { server, apiKey } = await resolve(id);
    const res = await request(
      `${baseUrl(server)}/train`,
      {
        method: 'POST',
        headers: { ...authHeaders(apiKey), 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      UPLOAD_TIMEOUT_MS,
    );
    return (await res.json()) as { job_id: string; status: string; plan: TrainingPlan };
  },

  /** Poll one remote job (`GET /jobs/:id`) — status, progress, and the loss metric series. */
  async getRemoteJob(id: string | Types.ObjectId, remoteJobId: string): Promise<RemoteJobStatus> {
    const { server, apiKey } = await resolve(id);
    const res = await request(`${baseUrl(server)}/jobs/${remoteJobId}`, { headers: authHeaders(apiKey) });
    return (await res.json()) as RemoteJobStatus;
  },

  /** Open a stream of the produced GGUF (`GET /jobs/:id/model`) for the route to pipe to the client. */
  async streamModel(id: string | Types.ObjectId, remoteJobId: string): Promise<Response> {
    const { server, apiKey } = await resolve(id);
    // No timeout wrapper: a multi-GB GGUF download can legitimately take a long while.
    const res = await fetch(`${baseUrl(server)}/jobs/${remoteJobId}/model`, { headers: authHeaders(apiKey) });
    if (!res.ok) {
      throw new FinetuneServerError(`model download failed: remote responded ${res.status}`, res.status);
    }
    return res;
  },
};
