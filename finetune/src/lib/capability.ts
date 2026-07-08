import type {
  Feasibility,
  FeasibilityEntry,
  HardwareInfo,
  InfeasiblePolicy,
  TrainStrategy,
  TrainingPlan,
} from '../types';
import { env } from '../config/env';
import { effectiveGpuCount, effectivePerGpuVramMb } from './hardware';

/**
 * Heuristic VRAM model for 4-bit QLoRA. Deliberately conservative; the numbers are
 * envelopes, not exact — real usage depends on the model architecture and kernels.
 *
 *   per-GPU VRAM  ≈  base_weights + fixed_overhead + activations
 *
 * where (ZeRO-2 replicates the base on every GPU; FSDP shards it across `gpus`).
 */
// nf4 4-bit weights + double-quant overhead, in GB per 1B params.
const BASE_GB_PER_B = 0.55;
// LoRA params + 8-bit optimizer state for the adapter + CUDA context + kernels.
const FIXED_OVERHEAD_GB = 2.5;
// Activation memory (with gradient checkpointing) per 1024 tokens, per micro-batch item.
const ACT_GB_PER_1K_TOKENS = 1.4;
// Sequence-length ladder tried by auto_adjust, longest first.
const SEQ_LADDER = [4096, 2048, 1024, 512, 256];
// Above this fraction of usable VRAM a fit is "tight" rather than "ok".
const TIGHT_THRESHOLD = 0.85;

const DEFAULT_SEQ_LEN = 2048;

interface FitResult {
  fits: boolean;
  strategy: TrainStrategy | null;
  estGb: number;
  usableGb: number;
  utilization: number; // estGb / usableGb (for the chosen strategy)
}

function activationsGb(seqLen: number, microBatch: number): number {
  return (seqLen / 1024) * ACT_GB_PER_1K_TOKENS * microBatch;
}

/**
 * Try to fit `sizeB` at a given seq_len/micro_batch. Prefers ZeRO-2 (simpler); falls back
 * to FSDP (base sharded across GPUs) when enabled and the base can't fit on one GPU.
 */
function tryFit(
  sizeB: number,
  seqLen: number,
  microBatch: number,
  usableGb: number,
  gpuCount: number,
): FitResult {
  const baseGb = sizeB * BASE_GB_PER_B;
  const act = activationsGb(seqLen, microBatch);

  // ZeRO-2: full base replicated per GPU.
  const zero2Gb = baseGb + FIXED_OVERHEAD_GB + act;
  if (zero2Gb <= usableGb) {
    return {
      fits: true,
      strategy: 'deepspeed_zero2',
      estGb: zero2Gb,
      usableGb,
      utilization: zero2Gb / usableGb,
    };
  }

  // FSDP: base sharded across all GPUs.
  if (env.ENABLE_FSDP && gpuCount > 1) {
    const fsdpGb = baseGb / gpuCount + FIXED_OVERHEAD_GB + act;
    if (fsdpGb <= usableGb) {
      return {
        fits: true,
        strategy: 'fsdp_qlora',
        estGb: fsdpGb,
        usableGb,
        utilization: fsdpGb / usableGb,
      };
    }
    return { fits: false, strategy: 'fsdp_qlora', estGb: fsdpGb, usableGb, utilization: fsdpGb / usableGb };
  }

  return { fits: false, strategy: 'deepspeed_zero2', estGb: zero2Gb, usableGb, utilization: zero2Gb / usableGb };
}

function classify(fit: FitResult): Feasibility {
  if (!fit.fits) return 'no';
  return fit.utilization > TIGHT_THRESHOLD ? 'tight' : 'ok';
}

export interface PlanInputs {
  sizeB: number;
  sizeSource: string;
  requestedSeqLen: number;
  microBatch: number;
  gradAccum: number;
  policy: InfeasiblePolicy;
}

/**
 * Compute the concrete training plan for a job, applying the infeasibility policy:
 *  - `auto_adjust`: if the request doesn't fit, walk the seq-length ladder down (and let
 *    FSDP kick in) until something fits, recording each downgrade. Returns feasibility
 *    'no' only if nothing fits — the caller should then reject.
 *  - `warn_proceed`: never downgrades; returns the requested settings with warnings and a
 *    best-effort strategy so the caller can start anyway.
 */
export function computePlan(hw: HardwareInfo, input: PlanInputs): TrainingPlan {
  const perGpuMb = effectivePerGpuVramMb(hw);
  const gpuCount = effectiveGpuCount(hw);
  const usableGb =
    perGpuMb != null ? (perGpuMb / 1024) * (1 - env.VRAM_SAFETY_MARGIN) : 0;

  const adjustments: string[] = [];
  const warnings: string[] = [];

  if (perGpuMb == null || gpuCount === 0) {
    warnings.push('no GPU detected; feasibility is a best-effort estimate');
  }

  const requested = tryFit(input.sizeB, input.requestedSeqLen, input.microBatch, usableGb, gpuCount);

  let chosen = requested;
  let seqLen = input.requestedSeqLen;

  if (!requested.fits && input.policy === 'auto_adjust' && usableGb > 0) {
    // Walk down from the requested seq_len (only shorter values than requested).
    for (const candidate of SEQ_LADDER) {
      if (candidate >= input.requestedSeqLen) continue;
      const fit = tryFit(input.sizeB, candidate, input.microBatch, usableGb, gpuCount);
      if (fit.fits) {
        chosen = fit;
        seqLen = candidate;
        adjustments.push(
          `reduced sequence_len ${input.requestedSeqLen} → ${candidate} to fit ${input.sizeB}B in ${usableGb.toFixed(1)}GB usable/GPU`,
        );
        if (fit.strategy === 'fsdp_qlora') {
          adjustments.push('switched strategy to FSDP+QLoRA (base sharded across GPUs)');
        }
        break;
      }
    }
  }

  const feasibility = classify(chosen);

  if (chosen.strategy === 'fsdp_qlora' && !adjustments.some((a) => a.includes('FSDP'))) {
    adjustments.push('using FSDP+QLoRA (base too large for a single GPU under ZeRO-2)');
  }
  if (feasibility === 'tight') {
    warnings.push(
      `fit is tight (~${chosen.estGb.toFixed(1)}GB of ${usableGb.toFixed(1)}GB usable/GPU); risk of OOM`,
    );
  }
  if (feasibility === 'no' && input.policy === 'warn_proceed') {
    warnings.push(
      `estimated ${chosen.estGb.toFixed(1)}GB/GPU exceeds ${usableGb.toFixed(1)}GB usable; likely to OOM (proceeding per policy)`,
    );
  }

  return {
    size_b: input.sizeB,
    size_source: input.sizeSource,
    strategy: chosen.strategy ?? 'deepspeed_zero2',
    sequence_len: seqLen,
    micro_batch_size: input.microBatch,
    gradient_accumulation_steps: input.gradAccum,
    feasibility,
    est_per_gpu_vram_gb: Number(chosen.estGb.toFixed(2)),
    usable_per_gpu_vram_gb: Number(usableGb.toFixed(2)),
    adjustments,
    warnings,
  };
}

/** Sizes surfaced in the `GET /hardware` feasibility table. */
const TABLE_SIZES = [7, 9, 14, 24, 32, 70];

/** Build the per-size feasibility table for the capability report. */
export function buildFeasibilityTable(hw: HardwareInfo): FeasibilityEntry[] {
  const perGpuMb = effectivePerGpuVramMb(hw);
  const gpuCount = effectiveGpuCount(hw);
  const usableGb =
    perGpuMb != null ? (perGpuMb / 1024) * (1 - env.VRAM_SAFETY_MARGIN) : 0;

  return TABLE_SIZES.map((sizeB) => {
    if (usableGb <= 0) {
      return {
        size_b: sizeB,
        feasibility: 'no' as Feasibility,
        strategy: null,
        max_sequence_len: null,
        note: 'no GPU detected',
      };
    }
    // Find the largest ladder seq_len that fits.
    let best: { seq: number; fit: FitResult } | null = null;
    for (const seq of SEQ_LADDER) {
      const fit = tryFit(sizeB, seq, 1, usableGb, gpuCount);
      if (fit.fits) {
        best = { seq, fit };
        break;
      }
    }
    if (!best) {
      const worst = tryFit(sizeB, SEQ_LADDER[SEQ_LADDER.length - 1]!, 1, usableGb, gpuCount);
      return {
        size_b: sizeB,
        feasibility: 'no' as Feasibility,
        strategy: null,
        max_sequence_len: null,
        note: `needs ~${worst.estGb.toFixed(1)}GB/GPU even at seq 256; exceeds ${usableGb.toFixed(1)}GB usable`,
      };
    }
    const feasibility = classify(best.fit);
    const strat = best.fit.strategy === 'fsdp_qlora' ? 'FSDP+QLoRA' : 'ZeRO-2 QLoRA';
    return {
      size_b: sizeB,
      feasibility,
      strategy: best.fit.strategy,
      max_sequence_len: best.seq,
      note:
        feasibility === 'tight'
          ? `${strat}, up to seq ${best.seq} (tight, ~${best.fit.estGb.toFixed(1)}GB/GPU)`
          : `${strat}, up to seq ${best.seq} (~${best.fit.estGb.toFixed(1)}GB/GPU)`,
    };
  });
}

export { DEFAULT_SEQ_LEN };
