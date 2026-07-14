/** Time formatting shared by the Autonomy board panels. */

/** Compact relative time — "in 3h", "5m ago", "just now". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const delta = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(delta);
  if (abs < 45_000) return delta >= 0 ? 'in <1m' : 'just now';
  const units: Array<[number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return delta >= 0 ? `in ${n}${label}` : `${n}${label} ago`;
    }
  }
  return '—';
}

export function fmtDateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** Run duration between two ISO stamps — "4s", "2m 10s", "1h 3m". */
export function duration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
