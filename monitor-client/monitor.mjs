#!/usr/bin/env node
/**
 * monitor-client — a tiny read-only metrics API for one machine (the Ubuntu inference boxes:
 * Intel CPU + NVIDIA GPU). It answers a single `GET /metrics.json` with a snapshot of CPU, memory,
 * GPU, temperatures, fans, disks and network, so an operator (or PleiadesAI later) can poll one URL
 * instead of shelling into the box.
 *
 * Design notes / invariants:
 *   - **No dependencies and no daemon state worth losing.** `node >= 18 monitor.mjs` runs it. The only
 *     state kept between requests is the previous CPU-jiffy and network-byte sample, used to turn the
 *     kernel's monotonic counters into rates. A first request after boot therefore reports rates as
 *     null rather than lying with a since-boot average.
 *   - **Everything is best-effort and independently degradable.** A box with no `nct6775` fan chip, no
 *     GPU, or no `nvidia-smi` still serves 200 with those sections empty and an entry in `warnings`.
 *     A monitoring endpoint that 500s because one sensor is missing is useless precisely when you need it.
 *   - **Sources are the kernel, not tools**, except for the GPU: /proc/stat, /proc/meminfo, /proc/net/dev
 *     and /sys/class/hwmon are read directly (cheap, no subprocess). Only NVIDIA needs `nvidia-smi`,
 *     which the container gets from the host via the NVIDIA container toolkit — see docker-compose.yml.
 *   - **Read-only by construction.** It never writes, and exposes no way to run anything. Auth is an
 *     optional shared key (MONITOR_API_KEY); unset means open, which is only OK on a trusted LAN.
 *   - It runs with `network_mode: host` so /proc/net/dev shows the *host's* NICs rather than a veth pair.
 *
 * Config is env only (all optional): MONITOR_PORT, MONITOR_BIND, MONITOR_API_KEY, MONITOR_DISKS,
 * MONITOR_CPU_SAMPLE_MS, NVIDIA_SMI. See .env.example.
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.MONITOR_PORT || 9101);
const BIND = process.env.MONITOR_BIND || '0.0.0.0';
const API_KEY = process.env.MONITOR_API_KEY || '';
const NVIDIA_SMI = process.env.NVIDIA_SMI || 'nvidia-smi';
const CPU_SAMPLE_MS = Number(process.env.MONITOR_CPU_SAMPLE_MS || 200); // 0 → no sampling, rates from last request
// "label:path" pairs; the compose bind-mounts the host root at /host/rootfs.
const DISKS = (process.env.MONITOR_DISKS || '/:/host/rootfs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const i = entry.indexOf(':');
    return i === -1 ? { label: entry, path: entry } : { label: entry.slice(0, i), path: entry.slice(i + 1) };
  });

const read = (p) => fs.readFileSync(p, 'utf8');
const tryRead = (p) => {
  try {
    return read(p);
  } catch {
    return null;
  }
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

/* ---------------------------------------------------------------- CPU ---- */

/** Parse the per-cpu jiffy counters in /proc/stat into { total, idle } per line. */
function readCpuJiffies() {
  const out = { total: null, cores: [] };
  for (const line of read('/proc/stat').split('\n')) {
    if (!line.startsWith('cpu')) break;
    const parts = line.trim().split(/\s+/);
    const vals = parts.slice(1).map(Number);
    // user nice system idle iowait irq softirq steal ...
    const idle = (vals[3] || 0) + (vals[4] || 0);
    const total = vals.reduce((a, b) => a + b, 0);
    const entry = { total, idle };
    if (parts[0] === 'cpu') out.total = entry;
    else out.cores.push(entry);
  }
  return out;
}

/** Busy fraction between two jiffy samples, or null when the counters didn't move. */
function usageBetween(prev, cur) {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return null;
  return round(((dTotal - dIdle) / dTotal) * 100);
}

function cpuStatic() {
  const info = tryRead('/proc/cpuinfo') || '';
  const model = /^model name\s*:\s*(.+)$/m.exec(info)?.[1]?.trim() || os.cpus()[0]?.model || null;
  const physicalIds = new Set();
  const coreIds = new Set();
  for (const block of info.split('\n\n')) {
    const phys = /^physical id\s*:\s*(\d+)$/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)$/m.exec(block)?.[1];
    if (phys !== undefined) physicalIds.add(phys);
    if (phys !== undefined && core !== undefined) coreIds.add(`${phys}/${core}`);
  }
  return {
    model,
    sockets: physicalIds.size || null,
    cores: coreIds.size || null,
    threads: os.cpus().length,
  };
}

/** Current per-core clock in MHz, from cpufreq when available, else the /proc/cpuinfo snapshot. */
function cpuFrequenciesMhz() {
  const freqs = [];
  for (let i = 0; ; i++) {
    const khz = tryRead(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
    if (khz === null) break;
    freqs.push(round(Number(khz.trim()) / 1000));
  }
  if (freqs.length) return freqs;
  const info = tryRead('/proc/cpuinfo') || '';
  return [...info.matchAll(/^cpu MHz\s*:\s*([\d.]+)$/gm)].map((m) => round(Number(m[1])));
}

/* ------------------------------------------------------------ memory ---- */

function memory() {
  const raw = tryRead('/proc/meminfo');
  if (!raw) return null;
  const kv = {};
  for (const line of raw.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB$/.exec(line);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? null;
  const available = kv.MemAvailable ?? null;
  const swapTotal = kv.SwapTotal ?? null;
  const swapFree = kv.SwapFree ?? null;
  return {
    total_bytes: total,
    available_bytes: available,
    // "used" here is total - available, i.e. what a new process genuinely can't have. free(1)'s notion.
    used_bytes: total !== null && available !== null ? total - available : null,
    used_percent: total ? round(((total - available) / total) * 100) : null,
    cached_bytes: kv.Cached ?? null,
    swap_total_bytes: swapTotal,
    swap_used_bytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
  };
}

/* ------------------------------------------------- hwmon: temps & fans ---- */

/**
 * Walk /sys/class/hwmon and collect every tempN_input / fanN_input / pwmN.
 * Chip names are what tells you what you're looking at: `coretemp`/`k10temp` (CPU package + cores),
 * `nct6775`-likes (motherboard fans and case temps), `nvme`, `acpitz`.
 */
function hwmon() {
  const temps = [];
  const fans = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync('/sys/class/hwmon');
  } catch {
    return { temps, fans, ok: false };
  }
  for (const d of dirs) {
    const base = `/sys/class/hwmon/${d}`;
    const chip = tryRead(`${base}/name`)?.trim() || d;
    let files = [];
    try {
      files = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const f of files) {
      const t = /^temp(\d+)_input$/.exec(f);
      if (t) {
        const milli = num(tryRead(`${base}/${f}`)?.trim());
        if (milli === null) continue;
        temps.push({
          chip,
          label: tryRead(`${base}/temp${t[1]}_label`)?.trim() || `temp${t[1]}`,
          celsius: round(milli / 1000),
          high_celsius: round(num(tryRead(`${base}/temp${t[1]}_max`)?.trim()) / 1000),
          critical_celsius: round(num(tryRead(`${base}/temp${t[1]}_crit`)?.trim()) / 1000),
        });
        continue;
      }
      const fan = /^fan(\d+)_input$/.exec(f);
      if (fan) {
        const rpm = num(tryRead(`${base}/${f}`)?.trim());
        if (rpm === null) continue;
        // pwmN is 0-255 duty on the matching channel, when the chip drives it.
        const pwm = num(tryRead(`${base}/pwm${fan[1]}`)?.trim());
        fans.push({
          chip,
          label: tryRead(`${base}/fan${fan[1]}_label`)?.trim() || `fan${fan[1]}`,
          rpm,
          duty_percent: pwm === null ? null : round((pwm / 255) * 100),
        });
      }
    }
  }
  return { temps, fans, ok: true };
}

/** The one number an operator actually wants: CPU package temp, whatever chip reports it. */
function cpuPackageTemp(temps) {
  const cpuChips = ['coretemp', 'k10temp', 'zenpower'];
  const pkg = temps.find((t) => cpuChips.includes(t.chip) && /package|tctl|tdie/i.test(t.label));
  if (pkg) return pkg.celsius;
  const anyCpu = temps.filter((t) => cpuChips.includes(t.chip));
  if (anyCpu.length) return Math.max(...anyCpu.map((t) => t.celsius));
  return temps.find((t) => t.chip === 'acpitz')?.celsius ?? null;
}

/* ------------------------------------------------------------- GPUs ---- */

const GPU_FIELDS = [
  'index',
  'name',
  'uuid',
  'temperature.gpu',
  'utilization.gpu',
  'utilization.memory',
  'memory.total',
  'memory.used',
  'fan.speed',
  'power.draw',
  'power.limit',
  'clocks.sm',
  'clocks.mem',
  'pstate',
];

/** Query NVIDIA GPUs. Resolves to `{ gpus, warning }` — never rejects; no GPU is a valid state. */
function nvidiaGpus() {
  return new Promise((resolve) => {
    execFile(
      NVIDIA_SMI,
      [`--query-gpu=${GPU_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          const why = err.code === 'ENOENT' ? `${NVIDIA_SMI} not found in container` : err.message;
          return resolve({ gpus: [], warning: `nvidia: ${why}` });
        }
        const gpus = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const c = line.split(',').map((s) => s.trim());
            const memTotal = num(c[6]);
            const memUsed = num(c[7]);
            return {
              index: num(c[0]),
              name: c[1] || null,
              uuid: c[2] || null,
              temperature_celsius: num(c[3]),
              utilization_percent: num(c[4]),
              memory_utilization_percent: num(c[5]),
              memory_total_bytes: memTotal === null ? null : memTotal * 1024 * 1024,
              memory_used_bytes: memUsed === null ? null : memUsed * 1024 * 1024,
              memory_used_percent: memTotal ? round((memUsed / memTotal) * 100) : null,
              fan_percent: num(c[8]), // null on datacenter cards, which are passively cooled
              power_draw_watts: num(c[9]),
              power_limit_watts: num(c[10]),
              clock_sm_mhz: num(c[11]),
              clock_mem_mhz: num(c[12]),
              pstate: c[13] || null,
            };
          });
        resolve({ gpus, warning: null });
      },
    );
  });
}

/* -------------------------------------------------- disks & network ---- */

function disks() {
  const out = [];
  for (const { label, path } of DISKS) {
    try {
      const s = fs.statfsSync(path);
      const total = s.blocks * s.bsize;
      // `bavail` (free to unprivileged) is the honest number; `bfree` includes the root reserve.
      const avail = s.bavail * s.bsize;
      const used = total - s.bfree * s.bsize;
      out.push({
        label,
        total_bytes: total,
        used_bytes: used,
        available_bytes: avail,
        used_percent: total ? round((used / total) * 100) : null,
      });
    } catch (err) {
      out.push({ label, error: err.code || String(err) });
    }
  }
  return out;
}

function readNetCounters() {
  const raw = tryRead('/proc/net/dev');
  if (!raw) return null;
  const ifaces = {};
  for (const line of raw.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (name === 'lo' || name.startsWith('veth') || name.startsWith('br-') || name === 'docker0') continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    ifaces[name] = { rx_bytes: v[0], rx_errors: v[2], tx_bytes: v[8], tx_errors: v[10] };
  }
  return ifaces;
}

/* ------------------------------------------------------- collection ---- */

// Previous sample, for turning monotonic counters into rates across requests.
let prev = { at: 0, cpu: null, net: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect() {
  const warnings = [];
  const cpuStart = readCpuJiffies();
  const netStart = readNetCounters();
  const startedAt = Date.now();

  // Kick off nvidia-smi *before* the sample window so the subprocess overlaps it rather than adding to it.
  const gpuPromise = nvidiaGpus();
  if (CPU_SAMPLE_MS > 0) await sleep(CPU_SAMPLE_MS);
  const cpuEnd = readCpuJiffies();
  const netEnd = readNetCounters();
  const elapsedSec = (Date.now() - startedAt) / 1000;

  // With a sample window we measure the window; without one we fall back to the gap since the last
  // request, which is still meaningful for a poller on a fixed interval.
  const cpuBase = CPU_SAMPLE_MS > 0 ? cpuStart : prev.cpu;
  const netBase = CPU_SAMPLE_MS > 0 ? netStart : prev.net;
  const netSpanSec = CPU_SAMPLE_MS > 0 ? elapsedSec : (startedAt - prev.at) / 1000;

  const { temps, fans, ok: hwmonOk } = hwmon();
  if (!hwmonOk) warnings.push('hwmon: /sys/class/hwmon unreadable — no temperatures or fan speeds');
  else {
    if (!temps.length) warnings.push('hwmon: no temperature sensors exposed (load coretemp on the host; WSL2 has none)');
    if (!fans.length) warnings.push('hwmon: no fan sensors exposed (needs a driver like nct6775 loaded on the host)');
  }

  const { gpus, warning: gpuWarning } = await gpuPromise;
  if (gpuWarning) warnings.push(gpuWarning);

  const net = {};
  if (netEnd) {
    for (const [name, cur] of Object.entries(netEnd)) {
      const base = netBase?.[name];
      const rate = base && netSpanSec > 0;
      net[name] = {
        rx_bytes: cur.rx_bytes,
        tx_bytes: cur.tx_bytes,
        rx_bytes_per_sec: rate ? round((cur.rx_bytes - base.rx_bytes) / netSpanSec) : null,
        tx_bytes_per_sec: rate ? round((cur.tx_bytes - base.tx_bytes) / netSpanSec) : null,
        rx_errors: cur.rx_errors,
        tx_errors: cur.tx_errors,
      };
    }
  }

  prev = { at: startedAt, cpu: cpuEnd, net: netEnd };
  const load = os.loadavg();

  return {
    collected_at: new Date().toISOString(),
    host: {
      hostname: tryRead('/host/hostname')?.trim() || os.hostname(),
      os: /^PRETTY_NAME="?([^"\n]+)"?/m.exec(tryRead('/host/os-release') || tryRead('/etc/os-release') || '')?.[1] || null,
      kernel: os.release(),
      uptime_sec: Math.round(num(tryRead('/proc/uptime')?.split(' ')[0]) ?? os.uptime()),
    },
    cpu: {
      ...cpuStatic(),
      usage_percent: usageBetween(cpuBase?.total, cpuEnd.total),
      per_core_percent: cpuEnd.cores.map((c, i) => usageBetween(cpuBase?.cores?.[i], c)),
      frequencies_mhz: cpuFrequenciesMhz(),
      temperature_celsius: cpuPackageTemp(temps),
      load_average: { '1m': round(load[0], 2), '5m': round(load[1], 2), '15m': round(load[2], 2) },
    },
    memory: memory(),
    gpus,
    temperatures: temps,
    fans,
    disks: disks(),
    network: net,
    warnings,
  };
}

/* ------------------------------------------------------------ server ---- */

function authorized(req) {
  if (!API_KEY) return true;
  const header = req.headers['x-api-key'];
  if (header && header === API_KEY) return true;
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') && auth.slice(7) === API_KEY;
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });

  // /health stays unauthenticated so a container healthcheck or uptime probe doesn't need the key.
  if (path === '/health') return send(res, 200, { status: 'ok', uptime_sec: Math.round(process.uptime()) });

  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  if (path === '/' || path === '/metrics.json') {
    try {
      return send(res, 200, await collect());
    } catch (err) {
      // Only a bug or a truly broken /proc gets here; the collectors swallow missing sensors themselves.
      return send(res, 500, { error: 'collection_failed', detail: String(err?.message || err) });
    }
  }

  send(res, 404, { error: 'not_found', endpoints: ['/metrics.json', '/health'] });
});

server.listen(PORT, BIND, () => {
  process.stdout.write(
    `monitor-client listening on http://${BIND}:${PORT} (auth: ${API_KEY ? 'api key' : 'OPEN — trusted LAN only'})\n`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
