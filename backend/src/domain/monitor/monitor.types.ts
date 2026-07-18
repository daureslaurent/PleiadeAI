/**
 * Wire shape of `GET /metrics.json` on a `monitor-client` (see `monitor-client/README.md`).
 *
 * Every field is nullable and every array can be empty **by design**: the client degrades one
 * section at a time (a box with no fan chip, no GPU, or no `nvidia-smi` still answers 200 with an
 * explanation in `warnings`). Nothing downstream may assume a sensor exists — treat this as a
 * best-effort report, not a contract about the hardware.
 */
export interface MonitorSnapshot {
  collected_at: string;
  host: {
    hostname: string | null;
    os: string | null;
    kernel: string | null;
    uptime_sec: number | null;
  };
  cpu: {
    model: string | null;
    sockets: number | null;
    cores: number | null;
    threads: number | null;
    usage_percent: number | null;
    per_core_percent: (number | null)[];
    frequencies_mhz: (number | null)[];
    temperature_celsius: number | null;
    load_average: { '1m': number | null; '5m': number | null; '15m': number | null };
  };
  memory: {
    total_bytes: number | null;
    available_bytes: number | null;
    used_bytes: number | null;
    used_percent: number | null;
    cached_bytes: number | null;
    swap_total_bytes: number | null;
    swap_used_bytes: number | null;
  } | null;
  gpus: MonitorGpu[];
  temperatures: MonitorTemperature[];
  fans: MonitorFan[];
  disks: MonitorDisk[];
  network: Record<string, MonitorNic>;
  warnings: string[];
}

export interface MonitorGpu {
  index: number | null;
  name: string | null;
  uuid: string | null;
  temperature_celsius: number | null;
  utilization_percent: number | null;
  memory_utilization_percent: number | null;
  memory_total_bytes: number | null;
  memory_used_bytes: number | null;
  memory_used_percent: number | null;
  /** Null on passively cooled datacenter cards — absence of a fan, not a missing reading. */
  fan_percent: number | null;
  power_draw_watts: number | null;
  power_limit_watts: number | null;
  clock_sm_mhz: number | null;
  clock_mem_mhz: number | null;
  pstate: string | null;
}

export interface MonitorTemperature {
  chip: string;
  label: string;
  celsius: number | null;
  high_celsius: number | null;
  critical_celsius: number | null;
}

export interface MonitorFan {
  chip: string;
  label: string;
  rpm: number | null;
  duty_percent: number | null;
}

export interface MonitorDisk {
  label: string;
  total_bytes?: number | null;
  used_bytes?: number | null;
  available_bytes?: number | null;
  used_percent?: number | null;
  /** Present instead of the numbers when the path couldn't be stat'd (e.g. missing bind mount). */
  error?: string;
}

export interface MonitorNic {
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_bytes_per_sec: number | null;
  tx_bytes_per_sec: number | null;
  rx_errors: number | null;
  tx_errors: number | null;
}

/**
 * What the poller keeps per target: the newest full snapshot, plus whether the last poll succeeded.
 * A target that has gone unreachable keeps its last good `snapshot` so the card can show *what it
 * looked like before it went dark* alongside the error, rather than blanking out.
 */
export interface MonitorLive {
  target_id: string;
  name: string;
  base_url: string;
  endpoint_id: string | null;
  note: string;
  online: boolean;
  /** Populated on failure; the reason the last poll didn't land (timeout, 401, connection refused). */
  error: string | null;
  /** Wall-clock of the last *successful* poll, ISO. Null until the first one lands. */
  last_ok_at: string | null;
  /** Round-trip of the last successful poll, ms — a cheap proxy for "is this box struggling". */
  latency_ms: number | null;
  snapshot: MonitorSnapshot | null;
  /** Threshold rules currently breaching, newest evaluation. Drives the card's warning count. */
  breaches: MonitorBreach[];
}

/** One threshold rule currently exceeded on a target. */
export interface MonitorBreach {
  /** Stable id for cooldown bookkeeping, e.g. `gpu_temp:0` or `disk:/`. */
  key: string;
  rule: 'cpu_temp' | 'gpu_temp' | 'memory' | 'vram' | 'disk' | 'offline';
  label: string;
  value: number | null;
  limit: number | null;
  severity: 'warn' | 'critical';
}

/**
 * One point in the history ring buffer. Reduced on purpose: keeping full snapshots for every tick
 * of every target would hold megabytes of sensor lists we never graph. Only what the drill-down
 * actually plots is retained.
 */
export interface MonitorSample {
  /** Epoch ms — smaller on the wire than an ISO string, and directly usable as a chart x value. */
  t: number;
  cpu: number | null;
  cpu_temp: number | null;
  mem: number | null;
  /** Per-GPU, index-aligned with the snapshot's `gpus`. */
  gpu_util: (number | null)[];
  gpu_vram: (number | null)[];
  gpu_temp: (number | null)[];
  /** Summed across NICs, bytes/sec. */
  rx: number | null;
  tx: number | null;
}
