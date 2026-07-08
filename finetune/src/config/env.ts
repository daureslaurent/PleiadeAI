import { z } from 'zod';

/**
 * Fail-fast environment validation, mirroring the main backend's `config/env.ts`:
 * a single Zod schema parsed once at module load; on any invalid/missing var we
 * print every issue and `process.exit(1)` so the process never boots half-configured.
 */
const EnvSchema = z.object({
  // --- HTTP API ---
  FINETUNE_PORT: z.coerce.number().int().positive().default(8088),
  // Bearer token every caller must present (mirrors the backend's per-endpoint api_key
  // convention). No default: refusing to boot without a secret is intentional.
  FINETUNE_API_KEY: z.string().min(8, 'FINETUNE_API_KEY must be set (>= 8 chars)'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(2048),

  // --- Filesystem (match the mounted docker volumes) ---
  DATA_DIR: z.string().default('/workspace/data'),
  MODELS_DIR: z.string().default('/workspace/models'),
  RUNS_DIR: z.string().default('/workspace/runs'),

  // --- Training / hardware ---
  NUM_GPUS: z.coerce.number().int().positive().default(2),
  // Default GGUF quantization for the exported model.
  GGUF_QUANT: z.string().default('q4_k_m'),
  // Optional HuggingFace token for gated/private base models.
  HF_TOKEN: z.string().optional(),
  // Path to the DeepSpeed ZeRO-2 config injected into every Axolotl run.
  DEEPSPEED_CONFIG: z.string().default('templates/zero2.json'),
  // llama.cpp checkout used for HF->GGUF conversion + quantization (bundled in the image).
  LLAMACPP_DIR: z.string().default('/opt/llama.cpp'),

  // --- Capacity planning ---
  // Fraction of each GPU's VRAM held back from the fit estimate (CUDA context, fragmentation).
  VRAM_SAFETY_MARGIN: z.coerce.number().min(0).max(0.9).default(0.1),
  // Override/assume per-GPU VRAM in GB when nvidia-smi is unavailable (e.g. local dev planning).
  // When set, capacity math uses this instead of / in absence of detected VRAM.
  GPU_VRAM_GB_OVERRIDE: z.coerce.number().positive().optional(),
  // Allow auto-switching to FSDP+QLoRA (shard base across GPUs) for models too big for ZeRO-2.
  ENABLE_FSDP: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  // --- Observability ---
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Pino depends on `env`, so we cannot use it here — plain stderr, like the backend loader.
  console.error('[finetune] Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
