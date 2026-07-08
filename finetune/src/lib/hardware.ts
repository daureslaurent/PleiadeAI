import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { GpuInfo, GpuUsage, HardwareInfo, UsageReport } from '../types';
import { env } from '../config/env';
import { createLogger } from '../config/logger';

const log = createLogger('hardware');
const execFileAsync = promisify(execFile);

/** Short cache so repeated /hardware calls (and every /train pre-flight) don't fork nvidia-smi. */
const CACHE_TTL_MS = 5_000;
let cache: { at: number; value: HardwareInfo } | null = null;

/** Usage is polled ~3s by the UI; a 1s cache collapses concurrent callers without going stale. */
const USAGE_CACHE_TTL_MS = 1_000;
let usageCache: { at: number; value: UsageReport } | null = null;

/**
 * Detect GPUs via `nvidia-smi`. Returns [] (not an error) when the tool is absent or fails,
 * so the service still boots and reports CPU/RAM on a non-GPU host.
 */
async function detectGpus(): Promise<{ gpus: GpuInfo[]; note?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,memory.total,memory.free',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
    );
    const gpus: GpuInfo[] = stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [index, name, total, free] = line.split(',').map((s) => s.trim());
        return {
          index: Number(index),
          name: name ?? 'unknown',
          vram_total_mb: Number(total),
          vram_free_mb: Number(free),
        };
      })
      .filter((g) => Number.isFinite(g.vram_total_mb));
    return { gpus };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'nvidia-smi unavailable; reporting no GPUs');
    return { gpus: [], note: 'nvidia-smi unavailable — GPU details not detected' };
  }
}

/**
 * Effective per-GPU VRAM (MB) used by the capacity planner. Detected minimum, unless
 * `GPU_VRAM_GB_OVERRIDE` is set (which also lets a non-GPU dev box plan capacity).
 */
export function effectivePerGpuVramMb(hw: HardwareInfo): number | null {
  if (env.GPU_VRAM_GB_OVERRIDE) return env.GPU_VRAM_GB_OVERRIDE * 1024;
  return hw.min_gpu_vram_mb;
}

/**
 * Number of GPUs the planner should assume for sharding math. When `GPU_VRAM_GB_OVERRIDE`
 * is set the operator is describing a target machine (planning mode), so trust the configured
 * `NUM_GPUS`; otherwise use the detected count.
 */
export function effectiveGpuCount(hw: HardwareInfo): number {
  if (env.GPU_VRAM_GB_OVERRIDE) return env.NUM_GPUS;
  return hw.gpu_count;
}

export async function getHardwareInfo(force = false): Promise<HardwareInfo> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const { gpus, note: gpuNote } = await detectGpus();
  const cpus = os.cpus();
  const vramTotals = gpus.map((g) => g.vram_total_mb);

  const notes: string[] = [];
  if (gpuNote) notes.push(gpuNote);
  if (env.GPU_VRAM_GB_OVERRIDE) {
    notes.push(`per-GPU VRAM overridden to ${env.GPU_VRAM_GB_OVERRIDE}GB for planning`);
  }

  const info: HardwareInfo = {
    gpus,
    gpu_count: gpus.length,
    min_gpu_vram_mb: vramTotals.length ? Math.min(...vramTotals) : null,
    total_gpu_vram_mb: vramTotals.reduce((a, b) => a + b, 0),
    cpu: {
      model: cpus[0]?.model.trim() ?? 'unknown',
      cores: cpus.length,
    },
    ram: {
      total_mb: Math.round(os.totalmem() / (1024 * 1024)),
      free_mb: Math.round(os.freemem() / (1024 * 1024)),
    },
    detected_at: new Date().toISOString(),
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };

  cache = { at: Date.now(), value: info };
  return info;
}

/** Parse a possibly-`[N/A]` nvidia-smi numeric cell. */
function optionalNum(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number(raw.trim());
  return Number.isFinite(v) ? v : null;
}

/**
 * Live utilization sample: per-GPU util%/VRAM/temp/power plus CPU load and RAM.
 *
 * Degrades gracefully exactly like {@link getHardwareInfo}: when `nvidia-smi` is missing the
 * report still carries CPU/RAM with `gpus: []` and an explanatory `note`, so the UI can render
 * "GPU telemetry unavailable" rather than break.
 */
export async function getUsageReport(force = false): Promise<UsageReport> {
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_CACHE_TTL_MS) {
    return usageCache.value;
  }

  let gpus: GpuUsage[] = [];
  let note: string | undefined;
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 5_000 },
    );
    gpus = stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const c = line.split(',').map((s) => s.trim());
        return {
          index: Number(c[0]),
          name: c[1] ?? 'unknown',
          util_pct: optionalNum(c[2]) ?? 0,
          vram_used_mb: optionalNum(c[3]) ?? 0,
          vram_total_mb: optionalNum(c[4]) ?? 0,
          temp_c: optionalNum(c[5]),
          power_w: optionalNum(c[6]),
        };
      })
      .filter((g) => Number.isFinite(g.index));
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'nvidia-smi unavailable; usage without GPUs');
    note = 'GPU telemetry unavailable (nvidia-smi not found)';
  }

  const cores = os.cpus().length;
  const load = os.loadavg() as [number, number, number];
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));

  const report: UsageReport = {
    gpus,
    cpu: {
      cores,
      load_avg: load,
      // 1-minute load average as a percentage of total core capacity.
      load_pct: cores > 0 ? Math.min(100, Math.round((load[0] / cores) * 100)) : 0,
    },
    ram: { used_mb: totalMb - freeMb, total_mb: totalMb },
    at: new Date().toISOString(),
    ...(note ? { note } : {}),
  };

  usageCache = { at: Date.now(), value: report };
  return report;
}
