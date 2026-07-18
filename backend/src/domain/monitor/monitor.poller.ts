import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { monitorTargetRepository } from './monitor-target.repository';
import { monitorService } from './monitor.service';
import { dispatch, evaluate, forget } from './monitor.alerts';
import type { MonitorLive, MonitorSample, MonitorSnapshot } from './monitor.types';

const log = createLogger('monitor-poller');

/**
 * The single background poller behind the Monitor page.
 *
 * Why a backend poller rather than the browser fetching each box directly:
 *   - the monitor-client API keys stay server-side (the browser never sees one);
 *   - no CORS story on a service whose job is to be simple;
 *   - **history survives a reload and is shared by every tab** — the operator's whole reason for
 *     wanting graphs. A per-tab buffer would reset on every navigation.
 *
 * History is kept in RAM only (an explicit decision — see MONITOR_PLAN.md). It is lost on backend
 * restart, which costs nothing an operator relies on and keeps steady sensor writes out of Mongo.
 *
 * Targets are polled **concurrently** every tick: a box that has gone dark burns the full 8s
 * service timeout, and serial polling would let one dead machine delay every healthy one behind it.
 */

/**
 * Bounds on the operator's history depth (`monitor_history_samples`, default 720 ≈ 2h at 10s). The
 * cap is on *samples*, not wall time, so a faster poll buys proportionally less history.
 *
 * The ceiling exists because this buffer is unswappable process memory: at ~200 bytes a sample,
 * 100k samples × a handful of machines is still only tens of MB, which is a defensible worst case
 * for a box also running inference. Anything past that wants a real time-series store, not RAM.
 */
const MIN_HISTORY_SAMPLES = 60;
const MAX_HISTORY_SAMPLES = 100_000;
const DEFAULT_HISTORY_SAMPLES = 720;
/** Floor on the poll interval — a misconfigured 0/1s would hammer every box in the fleet. */
const MIN_POLL_SECONDS = 5;

interface TargetState {
  live: MonitorLive;
  history: MonitorSample[];
}

const state = new Map<string, TargetState>();
let timer: NodeJS.Timeout | null = null;
let running = false;
/** Interval the current timer was armed with, so a settings change can re-arm it. */
let armedSeconds = 0;

/** Clamp the configured depth into the supported range; a blank/garbage setting falls back to the default. */
function historyCap(configured: number | undefined): number {
  const wanted = Number.isFinite(configured) && (configured ?? 0) > 0 ? Number(configured) : DEFAULT_HISTORY_SAMPLES;
  return Math.min(MAX_HISTORY_SAMPLES, Math.max(MIN_HISTORY_SAMPLES, Math.round(wanted)));
}

/**
 * Approximate heap cost of one sample, in bytes.
 *
 * This is an **estimate, not a measurement** — V8 gives no per-object retained size, and walking the
 * heap to find out would cost far more than the buffer itself. The model: a plain object with 9
 * properties runs roughly 120 bytes of header + slots, plus three arrays that each carry ~40 bytes
 * of overhead and 8 bytes per element. Nulls in those arrays may box rather than pack, so real usage
 * skews slightly *above* this figure; it is reported to the operator as an order-of-magnitude guide
 * for choosing a depth, not as an accounting number.
 */
const SAMPLE_BASE_BYTES = 120;
const ARRAY_BASE_BYTES = 40;
const ARRAY_ELEMENT_BYTES = 8;

function estimateSampleBytes(gpuCount: number): number {
  return SAMPLE_BASE_BYTES + 3 * (ARRAY_BASE_BYTES + gpuCount * ARRAY_ELEMENT_BYTES);
}

/** Reduce a full snapshot to the handful of series the drill-down actually graphs. */
function toSample(snapshot: MonitorSnapshot): MonitorSample {
  const nics = Object.values(snapshot.network ?? {});
  const sum = (pick: (n: (typeof nics)[number]) => number | null) =>
    nics.length ? nics.reduce((acc, n) => acc + (pick(n) ?? 0), 0) : null;

  return {
    t: Date.now(),
    cpu: snapshot.cpu?.usage_percent ?? null,
    cpu_temp: snapshot.cpu?.temperature_celsius ?? null,
    mem: snapshot.memory?.used_percent ?? null,
    gpu_util: (snapshot.gpus ?? []).map((g) => g.utilization_percent),
    gpu_vram: (snapshot.gpus ?? []).map((g) => g.memory_used_percent),
    gpu_temp: (snapshot.gpus ?? []).map((g) => g.temperature_celsius),
    rx: sum((n) => n.rx_bytes_per_sec),
    tx: sum((n) => n.tx_bytes_per_sec),
  };
}

/** Poll one target, update its live state + history, and run threshold alerting. */
async function pollTarget(
  target: Awaited<ReturnType<typeof monitorTargetRepository.listEnabledWithKeys>>[number],
  settings: Awaited<ReturnType<typeof settingsService.get>>,
): Promise<void> {
  const id = String(target._id);
  const previous = state.get(id);

  const live: MonitorLive = {
    target_id: id,
    name: target.name,
    base_url: target.base_url,
    endpoint_id: target.endpoint_id ? String(target.endpoint_id) : null,
    note: target.note ?? '',
    online: false,
    error: null,
    // Keep the last good reading so an offline card shows what the box looked like before it went dark.
    last_ok_at: previous?.live.last_ok_at ?? null,
    latency_ms: previous?.live.latency_ms ?? null,
    snapshot: previous?.live.snapshot ?? null,
    breaches: [],
  };

  try {
    const { snapshot, latency_ms } = await monitorService.probe(target);
    live.online = true;
    live.snapshot = snapshot;
    live.latency_ms = latency_ms;
    live.last_ok_at = new Date().toISOString();
    live.breaches = evaluate(snapshot, settings);

    const cap = historyCap(settings.monitor_history_samples);
    const history = previous?.history ?? [];
    history.push(toSample(snapshot));
    // Trims on every append, so lowering the setting takes effect on the next poll rather than
    // leaving the old buffer resident until a restart.
    if (history.length > cap) history.splice(0, history.length - cap);
    state.set(id, { live, history });
  } catch (err) {
    live.error = err instanceof Error ? err.message : String(err);
    live.breaches = [
      {
        key: 'offline',
        rule: 'offline',
        label: `Unreachable — ${live.error}`,
        value: null,
        limit: null,
        severity: 'critical',
      },
    ];
    // History is *not* extended on failure: a gap in the graph is the honest rendering of "we don't
    // know", and pushing zeros would draw a plunge to idle that never happened.
    state.set(id, { live, history: previous?.history ?? [] });
  }

  await dispatch(id, target.name, live.breaches, settings);
}

async function tick(): Promise<void> {
  if (running) return; // a slow round must never overlap itself
  running = true;
  try {
    const settings = await settingsService.get();
    const targets = await monitorTargetRepository.listEnabledWithKeys();

    // Drop state for targets that were deleted or disabled since the last tick, so the dashboard
    // stops showing them and a re-enable starts from a clean alert history.
    const liveIds = new Set(targets.map((t) => String(t._id)));
    for (const id of [...state.keys()]) {
      if (!liveIds.has(id)) {
        state.delete(id);
        forget(id);
      }
    }

    await Promise.all(targets.map((t) => pollTarget(t, settings)));

    // Re-arm if the operator changed the interval while we were running.
    const wanted = Math.max(MIN_POLL_SECONDS, settings.monitor_poll_seconds || MIN_POLL_SECONDS);
    if (wanted !== armedSeconds) arm(wanted);
  } catch (err) {
    log.error({ err }, 'monitor poll tick failed');
  } finally {
    running = false;
  }
}

function arm(seconds: number): void {
  if (timer) clearInterval(timer);
  armedSeconds = seconds;
  timer = setInterval(() => void tick(), seconds * 1000);
  timer.unref?.();
  log.info({ seconds }, 'monitor poller armed');
}

export const monitorPoller = {
  /** Start polling. Called once at boot, next to the other pollers in `index.ts`. */
  start(): void {
    if (timer) return;
    arm(MIN_POLL_SECONDS); // provisional; the first tick re-arms to the configured interval
    void tick();
  },

  /** Newest state for every enabled target, ordered by name — exactly what the fleet grid renders. */
  live(): MonitorLive[] {
    return [...state.values()].map((s) => s.live).sort((a, b) => a.name.localeCompare(b.name));
  },

  liveFor(targetId: string): MonitorLive | null {
    return state.get(targetId)?.live ?? null;
  },

  history(targetId: string): MonitorSample[] {
    return state.get(targetId)?.history ?? [];
  },

  /**
   * What the in-RAM history currently costs, per target and in total — the readout behind the
   * history-depth setting, so the operator can see the price of a deeper buffer before raising it.
   *
   * `bytes` is an estimate (see {@link estimateSampleBytes}); `oldest`/`newest` are what actually
   * answers "how far back can I look", which the sample count alone doesn't say once a machine has
   * been offline for a while and left gaps.
   */
  stats(cap: number): {
    cap: number;
    total_samples: number;
    total_bytes: number;
    targets: { target_id: string; name: string; samples: number; bytes: number; oldest: number | null; newest: number | null }[];
  } {
    const targets = [...state.values()].map((s) => {
      const gpuCount = s.history.length ? (s.history[s.history.length - 1]?.gpu_util.length ?? 0) : 0;
      return {
        target_id: s.live.target_id,
        name: s.live.name,
        samples: s.history.length,
        bytes: s.history.length * estimateSampleBytes(gpuCount),
        oldest: s.history[0]?.t ?? null,
        newest: s.history[s.history.length - 1]?.t ?? null,
      };
    });
    return {
      cap: historyCap(cap),
      total_samples: targets.reduce((n, t) => n + t.samples, 0),
      total_bytes: targets.reduce((n, t) => n + t.bytes, 0),
      targets: targets.sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  /**
   * Poll now instead of waiting for the next tick. Used after a target is added or edited so the
   * dashboard fills in immediately rather than looking broken for up to a full interval.
   */
  async refresh(): Promise<void> {
    await tick();
  },
};
