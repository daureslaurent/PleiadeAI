import type { MonitorBreach } from '../../lib/api';

/**
 * Shared formatting + tone rules for the Monitor page.
 *
 * Tone is semantic per DIRECT_ART §2: emerald = headroom, amber = tight/warning, red = saturated or
 * breaching. Nothing here spends accent blue on a reading — blue belongs to actions.
 */

export type Tone = 'ok' | 'warn' | 'critical' | 'idle';

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  critical: 'text-red-300',
  idle: 'text-slate-400',
};

export const TONE_BAR: Record<Tone, string> = {
  ok: 'bg-emerald-400/80',
  warn: 'bg-amber-400/80',
  critical: 'bg-red-400/80',
  idle: 'bg-slate-500/50',
};

export const TONE_RING: Record<Tone, string> = {
  ok: 'border-emerald-500/25',
  warn: 'border-amber-500/30',
  critical: 'border-red-500/35',
  idle: 'border-white/[0.06]',
};

/**
 * Utilization → tone. A *busy* machine is not a problem, so the thresholds here are about headroom,
 * not health; genuine health limits come from the operator's settings and arrive as breaches.
 */
export function loadTone(pct: number | null | undefined): Tone {
  if (pct === null || pct === undefined) return 'idle';
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warn';
  return 'ok';
}

/**
 * Temperature → tone, relative to the sensor's *own* limits when it reports them. A 60°C NVMe and a
 * 60°C CPU package mean different things; `high`/`critical` from hwmon say which, so use them and
 * only fall back to fixed numbers for sensors that expose no thresholds.
 */
export function tempTone(celsius: number | null, high?: number | null, critical?: number | null): Tone {
  if (celsius === null) return 'idle';
  // hwmon reports unset thresholds as absurd sentinels (we've seen 65261.9 from an NVMe); ignore those.
  const sane = (v: number | null | undefined) => (typeof v === 'number' && v > 0 && v < 200 ? v : null);
  const crit = sane(critical);
  const warn = sane(high);
  if (crit && celsius >= crit - 5) return 'critical';
  if (warn && celsius >= warn - 5) return 'warn';
  if (!crit && !warn) {
    if (celsius >= 85) return 'critical';
    if (celsius >= 70) return 'warn';
  }
  return 'ok';
}

/** The worst tone among a target's active breaches — what colors its card border and status dot. */
export function breachTone(breaches: MonitorBreach[]): Tone {
  if (breaches.some((b) => b.severity === 'critical')) return 'critical';
  if (breaches.length) return 'warn';
  return 'ok';
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Bytes → a short human string. Used for RAM, VRAM and disks alike so sizes read consistently. */
export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : digits)} ${UNITS[unit]}`;
}

/** Bytes/sec → a rate string. Separate from {@link bytes} so the `/s` is never accidentally dropped. */
export function rate(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : `${bytes(n, 1)}/s`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;
}

export function celsius(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${Math.round(n)}°C`;
}

/** Seconds → `12d 4h` / `4h 12m` / `12m`. Uptime is context, so it stays coarse on purpose. */
export function uptime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3s ago" / "4m ago" — how stale a reading is, for cards that have gone quiet. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(delta)) return 'never';
  if (delta < 5) return 'just now';
  if (delta < 60) return `${Math.round(delta)}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  return `${Math.round(delta / 3600)}h ago`;
}
