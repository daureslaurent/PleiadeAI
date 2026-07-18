import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';
import { monitorApi, type MonitorStats } from '../../lib/api';
import { bytes } from '../../components/monitor/format';
import { useSettings } from './context';

/**
 * Live readout of what the Monitor history buffer costs in backend RAM, shown beside the depth
 * setting so the operator can see the price before raising it.
 *
 * It re-reads whenever the configured depth changes, which is what makes the setting legible: type
 * 5000, watch the projection jump, decide. The *projected* figure matters more than the current one
 * — a freshly-started backend holds almost nothing, so "currently 40 KB" would make any depth look
 * free until hours later.
 *
 * Byte figures are estimates (V8 exposes no per-object retained size); the wording says so rather
 * than implying an accounting number.
 */
export function HistoryUsage() {
  const { form } = useSettings();
  const [stats, setStats] = useState<MonitorStats | null>(null);

  useEffect(() => {
    let alive = true;
    monitorApi
      .stats()
      .then((s) => alive && setStats(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [form.monitor_history_samples]);

  if (!stats) return null;

  const machines = stats.targets.length;
  // Per-sample cost implied by what's actually retained, so the projection reflects real GPU counts
  // rather than a guess. Falls back to the poller's own ~200B/sample model before anything is held.
  const perSample = stats.total_samples > 0 ? stats.total_bytes / stats.total_samples : 200;
  const projected = perSample * stats.cap * Math.max(1, machines);

  const span = stats.targets
    .map((t) => (t.oldest && t.newest ? t.newest - t.oldest : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  const hours = span / 3_600_000;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        <Database size={11} /> History in backend RAM
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Figure label="Held now" value={bytes(stats.total_bytes)} sub={`${stats.total_samples.toLocaleString()} samples`} />
        <Figure
          label="At full depth"
          value={`≈ ${bytes(projected)}`}
          sub={`${stats.cap.toLocaleString()} × ${machines || 1} machine${machines === 1 ? '' : 's'}`}
        />
        <Figure
          label="Reaches back"
          value={span ? `${hours < 1 ? `${Math.round(span / 60_000)}m` : `${hours.toFixed(1)}h`}` : '—'}
          sub={span ? 'oldest sample' : 'still filling'}
        />
      </div>

      {stats.cap !== form.monitor_history_samples && (
        <p className="mt-2 text-[10px] text-amber-300/80">
          Clamped to {stats.cap.toLocaleString()} (allowed range 60–100,000).
        </p>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
        Estimated, not measured — the exact heap cost of a JS object isn't observable. Lowering the depth
        trims each buffer on the next poll; the whole buffer is lost on a backend restart either way.
      </p>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="font-mono text-sm text-slate-200">{value}</div>
      <div className="font-mono text-[10px] text-slate-500">{sub}</div>
    </div>
  );
}
