/**
 * Shared type contracts for the fine-tune service. Kept in one file so the API layer
 * (`server.ts`), the orchestrator (`trainer.ts`), and the job store agree on shapes.
 */

/** Lifecycle phases a job moves through, in order. Terminal: `done` | `failed`. */
export type JobPhase =
  | 'queued'
  | 'preparing'
  | 'training'
  | 'exporting'
  | 'done'
  | 'failed';

/**
 * Per-run hyperparameter overrides. Everything is optional; `axolotl-config.ts`
 * supplies 13–14B-safe defaults for anything omitted.
 */
export interface HyperParams {
  sequence_len?: number;
  micro_batch_size?: number;
  gradient_accumulation_steps?: number;
  num_epochs?: number;
  learning_rate?: number;
  lora_r?: number;
  lora_alpha?: number;
  lora_dropout?: number;
  warmup_ratio?: number;
  save_steps?: number;
  /** Override the exported GGUF quantization (default from env `GGUF_QUANT`). */
  gguf_quant?: string;
}

/**
 * One training-progress datapoint, parsed best-effort from the HF Trainer's stdout dicts
 * (`{'loss': 1.23, 'learning_rate': 1e-4, 'epoch': 0.42}`). Drives the UI's loss curve.
 */
export interface TrainMetric {
  step: number;
  loss: number;
  epoch?: number;
  lr?: number;
  at: string;
}

/** How to handle a request that doesn't fit the hardware envelope. */
export type InfeasiblePolicy = 'auto_adjust' | 'warn_proceed';

/** Validated body of `POST /train`. */
export interface TrainRequest {
  base_model: string;
  run_name: string;
  dataset_id: string;
  webhook_url?: string;
  hyperparams?: HyperParams;
  /**
   * Optional asserted parameter count (in billions) of `base_model`. When omitted the
   * service derives it from the model name / HF config. Lets the app request a size
   * (e.g. 9, 24) explicitly and skip the lookup.
   */
  target_size_b?: number;
  /**
   * What to do when the (size, hardware) combo won't fit:
   *  - `auto_adjust` (default): tighten settings / switch strategy to make it fit; reject if impossible.
   *  - `warn_proceed`: start best-effort with warnings and let it OOM if too big.
   */
  on_infeasible?: InfeasiblePolicy;
}

// --- Hardware & capacity planning ---

export interface GpuInfo {
  index: number;
  name: string;
  vram_total_mb: number;
  vram_free_mb: number;
}

export interface HardwareInfo {
  gpus: GpuInfo[];
  gpu_count: number;
  /** Smallest per-GPU total VRAM — the binding constraint for ZeRO-2 (base is replicated). */
  min_gpu_vram_mb: number | null;
  total_gpu_vram_mb: number;
  cpu: { model: string; cores: number };
  ram: { total_mb: number; free_mb: number };
  detected_at: string;
  /** Set when GPUs couldn't be detected or an override was applied. */
  note?: string;
}

/** Live per-GPU utilization sample (from `nvidia-smi`). */
export interface GpuUsage {
  index: number;
  name: string;
  util_pct: number;
  vram_used_mb: number;
  vram_total_mb: number;
  temp_c: number | null;
  power_w: number | null;
}

/** Response of `GET /usage`: real-time load, distinct from the static `/hardware` report. */
export interface UsageReport {
  gpus: GpuUsage[];
  cpu: { cores: number; load_avg: [number, number, number]; load_pct: number };
  ram: { used_mb: number; total_mb: number };
  at: string;
  /** Set when GPU telemetry is unavailable (no nvidia-smi). */
  note?: string;
}

export type Feasibility = 'ok' | 'tight' | 'no';
export type TrainStrategy = 'deepspeed_zero2' | 'fsdp_qlora';

/** Concrete, hardware-fitted training settings chosen for one job. */
export interface TrainingPlan {
  size_b: number;
  size_source: string;
  strategy: TrainStrategy;
  sequence_len: number;
  micro_batch_size: number;
  gradient_accumulation_steps: number;
  feasibility: Feasibility;
  est_per_gpu_vram_gb: number;
  usable_per_gpu_vram_gb: number;
  /** Human-readable downgrades applied to make it fit (auto_adjust). */
  adjustments: string[];
  /** Human-readable risks when proceeding despite a poor fit (warn_proceed). */
  warnings: string[];
}

/** One row of the capability feasibility table. */
export interface FeasibilityEntry {
  size_b: number;
  feasibility: Feasibility;
  strategy: TrainStrategy | null;
  /** Largest sequence length that still fits at this size, or null if it can't fit at all. */
  max_sequence_len: number | null;
  note: string;
}

/** Response of `GET /hardware`: raw hardware + a per-size feasibility table. */
export interface CapabilityReport {
  hardware: HardwareInfo;
  sizes: FeasibilityEntry[];
}

/** In-memory record of a training job. */
export interface Job {
  id: string;
  run_name: string;
  base_model: string;
  dataset_path: string;
  webhook_url?: string;
  hyperparams: HyperParams;
  /** Hardware-fitted training plan resolved at accept time. */
  plan: TrainingPlan;
  phase: JobPhase;
  /** Coarse 0..1 progress derived from parsed training logs (best-effort). */
  progress: number;
  /** Absolute path to the produced GGUF, set once `phase === 'done'`. */
  artifact_path?: string;
  gguf_filename?: string;
  error?: string;
  /** Ring buffer of the most recent training stdout/stderr lines, for `GET /jobs/:id`. */
  log_tail: string[];
  /** Ring buffer of parsed training metrics (loss curve). */
  metrics: TrainMetric[];
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
}

/** Public projection of a job returned by `GET /jobs/:id` (drops internal fields). */
export interface JobStatus {
  job_id: string;
  run_name: string;
  base_model: string;
  status: JobPhase;
  progress: number;
  plan: TrainingPlan;
  gguf_filename?: string;
  error?: string;
  log_tail: string[];
  metrics: TrainMetric[];
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
}

/** Payload POSTed to the caller's `webhook_url` on completion or failure. */
export interface WebhookPayload {
  job_id: string;
  run_name: string;
  status: 'done' | 'failed';
  base_model: string;
  gguf_filename?: string;
  /** Where the backend can pull the artifact, e.g. `GET /jobs/:id/model`. */
  download_url?: string;
  error?: string;
}
