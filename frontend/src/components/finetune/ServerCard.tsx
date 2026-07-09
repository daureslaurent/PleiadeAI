import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Cpu, Loader2, RefreshCw, Server, Zap } from 'lucide-react';
import {
  finetuneServersApi,
  type Feasibility,
  type FinetuneServer,
  type HardwareReport,
} from '../../lib/api';
import { useUsagePolling } from './useUsagePolling';

/**
 * One fine-tune server: live utilization gauges on top (polled while the page is open), then the
 * static hardware + per-model-size feasibility table beneath.
 *
 * Colors are semantic per DIRECT_ART: emerald = headroom / ok, amber = tight, red = saturated / no.
 */
const FEASIBILITY_STYLE: Record<Feasibility, string> = {
  ok: 'text-emerald-300',
  tight: 'text-amber-300',
  no: 'text-red-300/70',
};

/** Utilization → semantic tone. Saturation is only "bad" in the sense of "no headroom left". */
function loadTone(pct: number): { bar: string; text: string } {
  if (pct >= 90) return { bar: 'bg-red-400/80', text: 'text-red-300' };
  if (pct >= 60) return { bar: 'bg-amber-400/80', text: 'text-amber-300' };
  return { bar: 'bg-emerald-400/80', text: 'text-emerald-300' };
}

const gb = (mb: number) => (mb / 1024).toFixed(1);

export function ServerCard({ server }: { server: FinetuneServer }) {
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [hwError, setHwError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The remote service's own build version (GET /health) — bumped independently of this app.
  const [version, setVersion] = useState<string | null>(null);

  // Live telemetry: paused when the tab is hidden, stopped on unmount.
  const { usage, error: usageError } = useUsagePolling(server._id, 3000, server.enabled);

  useEffect(() => {
    let alive = true;
    finetuneServersApi
      .health(server._id)
      .then((h) => alive && setVersion(h.version ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [server._id]);

  const loadHardware = useCallback(async () => {
    setRefreshing(true);
    try {
      setHardware(await finetuneServersApi.hardware(server._id));
      setHwError(null);
    } catch (err) {
      setHwError(err instanceof Error ? err.message : 'unreachable');
    } finally {
      setRefreshing(false);
    }
  }, [server._id]);

  useEffect(() => {
    void loadHardware();
  }, [loadHardware]);

  const anyLive = (usage?.gpus ?? []).some((g) => g.util_pct > 5);

  return (
    <div className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-4">
      <header className="mb-3 flex items-center gap-2.5">
        <Server size={15} className="text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-100">{server.name}</span>
            {version && (
              <span
                title="fine-tune server build version"
                className="shrink-0 rounded-full bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
              >
                v{version}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-slate-500">{server.base_url}</div>
        </div>
        {anyLive && (
          <span className="text-shimmer text-[10px] uppercase tracking-wider text-accent">live</span>
        )}
        <button
          onClick={() => void loadHardware()}
          disabled={refreshing}
          title="Refresh capability"
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200 disabled:opacity-50"
        >
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </header>

      {hwError && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-300">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="truncate">Server unreachable: {hwError}</span>
        </div>
      )}

      {/* --- Live usage --- */}
      <div className="mb-3 space-y-2">
        {usageError && !usage ? (
          <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-[11px] text-slate-500">
            Telemetry unavailable
          </div>
        ) : !usage ? (
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-[11px] text-slate-500">
            <Loader2 size={12} className="animate-spin" /> Reading utilization…
          </div>
        ) : (
          <>
            {usage.gpus.length === 0 ? (
              <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-[11px] text-slate-500">
                {usage.note ?? 'GPU telemetry unavailable'}
              </div>
            ) : (
              usage.gpus.map((g) => {
                const tone = loadTone(g.util_pct);
                const vramPct = g.vram_total_mb ? (g.vram_used_mb / g.vram_total_mb) * 100 : 0;
                return (
                  <div key={g.index} className="rounded-xl border border-white/[0.06] bg-black/20 p-2.5">
                    <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                      <Zap size={11} className={tone.text} />
                      <span className="truncate text-slate-300">
                        GPU{g.index} · {g.name}
                      </span>
                      <span className={`ml-auto font-mono ${tone.text}`}>{g.util_pct}%</span>
                    </div>

                    <Meter pct={g.util_pct} barClass={tone.bar} />

                    <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-slate-500">
                      <span>
                        VRAM {gb(g.vram_used_mb)}/{gb(g.vram_total_mb)} GB ({vramPct.toFixed(0)}%)
                      </span>
                      <span className="flex gap-2.5">
                        {g.temp_c != null && <span>{g.temp_c}°C</span>}
                        {g.power_w != null && <span>{Math.round(g.power_w)}W</span>}
                      </span>
                    </div>
                    <div className="mt-1">
                      <Meter pct={vramPct} barClass="bg-accent/60" thin />
                    </div>
                  </div>
                );
              })
            )}

            {/* CPU + RAM */}
            <div className="rounded-xl border border-white/[0.06] bg-black/20 p-2.5">
              <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                <Cpu size={11} className={loadTone(usage.cpu.load_pct).text} />
                <span className="text-slate-300">CPU · {usage.cpu.cores} cores</span>
                <span className={`ml-auto font-mono ${loadTone(usage.cpu.load_pct).text}`}>
                  {usage.cpu.load_pct}%
                </span>
              </div>
              <Meter pct={usage.cpu.load_pct} barClass={loadTone(usage.cpu.load_pct).bar} />
              <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-slate-500">
                <span>load {usage.cpu.load_avg.map((l) => l.toFixed(2)).join(' / ')}</span>
                <span>
                  RAM {gb(usage.ram.used_mb)}/{gb(usage.ram.total_mb)} GB
                </span>
              </div>
              <div className="mt-1">
                <Meter
                  pct={usage.ram.total_mb ? (usage.ram.used_mb / usage.ram.total_mb) * 100 : 0}
                  barClass="bg-accent/60"
                  thin
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* --- Static capability --- */}
      {hardware && (
        <div className="overflow-x-auto rounded-xl border border-white/[0.06] bg-white/[0.03]">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="border-b border-white/[0.06] text-[10px] uppercase tracking-wider text-slate-500">
                <th className="px-3 py-1.5 font-normal">Size</th>
                <th className="px-3 py-1.5 font-normal">Fit</th>
                <th className="px-3 py-1.5 font-normal">Strategy</th>
                <th className="px-3 py-1.5 text-right font-normal">Max seq</th>
              </tr>
            </thead>
            <tbody>
              {hardware.sizes.map((s) => (
                <tr key={s.size_b} className="border-b border-white/[0.06] last:border-0" title={s.note}>
                  <td className="px-3 py-1.5 font-mono text-slate-200">{s.size_b}B</td>
                  <td className={`px-3 py-1.5 font-medium ${FEASIBILITY_STYLE[s.feasibility]}`}>
                    {s.feasibility}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {s.strategy === 'fsdp_qlora' ? 'FSDP' : s.strategy === 'deepspeed_zero2' ? 'ZeRO-2' : '—'}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono text-slate-400">
                    {s.max_sequence_len ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Thin utilization bar. Purely presentational; width is the only animated property. */
function Meter({ pct, barClass, thin }: { pct: number; barClass: string; thin?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-full bg-black/40 ${thin ? 'h-0.5' : 'h-1'}`}>
      <div
        className={`h-full rounded-full transition-all duration-500 ${barClass}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}
