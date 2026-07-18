import { AlertTriangle, Cpu, HardDrive, Server, Thermometer, WifiOff, Zap } from 'lucide-react';
import type { MonitorLive, MonitorSample } from '../../lib/api';
import { Meter, Sparkline } from './Meter';
import { TONE_RING, TONE_TEXT, ago, breachTone, bytes, celsius, loadTone, pct, tempTone, uptime } from './format';

/**
 * One machine in the fleet grid: the four numbers you'd actually check before trusting a box with a
 * job — CPU, memory, each GPU, hottest sensor — plus a CPU sparkline for shape over time.
 *
 * Everything deeper (all sensors, fans, disks, NICs, per-core) lives in the drill-down; this card is
 * a *triage* surface and stays scannable at a glance across N servers.
 *
 * Liveness follows DIRECT_ART §6: a card that is polling and breaching pulses in its breach color;
 * a healthy or offline one is still. Motion marks liveness, never decoration.
 */
export function ServerCard({
  live,
  history,
  endpointName,
  onOpen,
}: {
  live: MonitorLive;
  history: MonitorSample[];
  /** Name of the inference endpoint running on this box, when one is linked. */
  endpointName: string | null;
  onOpen: () => void;
}) {
  const snap = live.snapshot;
  const tone = live.online ? breachTone(live.breaches) : 'critical';
  const critical = live.breaches.some((b) => b.severity === 'critical');

  const cpuSeries: [number, number | null][] = history.map((s) => [s.t, s.cpu]);
  const hottest = [...(snap?.temperatures ?? [])]
    .filter((t) => t.celsius !== null)
    .sort((a, b) => (b.celsius ?? 0) - (a.celsius ?? 0))[0];
  const rootDisk = (snap?.disks ?? []).find((d) => d.used_percent !== null && d.used_percent !== undefined);

  return (
    <button
      onClick={onOpen}
      style={critical && live.online ? ({ '--glow': 'rgba(239,68,68,0.18)' } as React.CSSProperties) : undefined}
      className={`glass-card animate-fade-up group w-full rounded-2xl border p-4 text-left transition-shadow hover:border-white/[0.14] ${
        TONE_RING[tone]
      } ${critical && live.online ? 'animate-glow-pulse' : ''}`}
    >
      <header className="mb-3 flex items-center gap-2.5">
        {live.online ? (
          <Server size={15} className={TONE_TEXT[tone]} />
        ) : (
          <WifiOff size={15} className="text-red-400" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-slate-100">{live.name}</span>
            {endpointName && (
              <span
                title={`Runs the “${endpointName}” inference endpoint`}
                className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent"
              >
                {endpointName}
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[11px] text-slate-500">
            {snap?.host?.hostname ?? live.base_url}
            {snap?.host?.uptime_sec != null && ` · up ${uptime(snap.host.uptime_sec)}`}
          </div>
        </div>
        {live.breaches.length > 0 && live.online && (
          <span
            title={live.breaches.map((b) => b.label).join('\n')}
            className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${
              critical ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'
            }`}
          >
            <AlertTriangle size={10} /> {live.breaches.length}
          </span>
        )}
      </header>

      {!live.online ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-300">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={12} className="shrink-0" /> Unreachable
          </div>
          <div className="mt-0.5 break-words font-mono text-[10px] text-red-300/70">{live.error}</div>
          <div className="mt-1 text-[10px] text-slate-500">Last reading {ago(live.last_ok_at)}</div>
        </div>
      ) : !snap ? (
        <div className="rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2 text-[11px] text-slate-500">
          Waiting for the first reading…
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* CPU — the one series worth a shape on the overview card. */}
          <div className="rounded-xl border border-white/[0.06] bg-black/20 p-2.5">
            <div className="mb-1.5 flex items-center gap-2 text-[11px]">
              <Cpu size={11} className={TONE_TEXT[loadTone(snap.cpu?.usage_percent)]} />
              <span className="truncate text-slate-300">{snap.cpu?.threads ?? '?'} threads</span>
              {snap.cpu?.temperature_celsius != null && (
                <span className={`font-mono ${TONE_TEXT[tempTone(snap.cpu.temperature_celsius)]}`}>
                  {celsius(snap.cpu.temperature_celsius)}
                </span>
              )}
              <span className={`ml-auto font-mono ${TONE_TEXT[loadTone(snap.cpu?.usage_percent)]}`}>
                {pct(snap.cpu?.usage_percent)}
              </span>
            </div>
            <Sparkline points={cpuSeries} tone={loadTone(snap.cpu?.usage_percent)} height={30} />
          </div>

          <Meter
            label="Memory"
            value={snap.memory?.used_percent ?? null}
            tone={loadTone(snap.memory?.used_percent)}
            detail={`${bytes(snap.memory?.used_bytes)} / ${bytes(snap.memory?.total_bytes)}`}
          />

          {snap.gpus.map((g) => (
            <div key={g.uuid ?? g.index} className="rounded-xl border border-white/[0.06] bg-black/20 p-2.5">
              <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                <Zap size={11} className={TONE_TEXT[loadTone(g.utilization_percent)]} />
                <span className="truncate text-slate-300">
                  GPU{g.index} · {g.name?.replace(/^NVIDIA\s+/, '') ?? 'unknown'}
                </span>
                <span className={`ml-auto shrink-0 font-mono ${TONE_TEXT[tempTone(g.temperature_celsius)]}`}>
                  {celsius(g.temperature_celsius)}
                </span>
              </div>
              <Meter value={g.utilization_percent} tone={loadTone(g.utilization_percent)} thin />
              <div className="mt-1.5">
                <Meter
                  value={g.memory_used_percent}
                  tone={loadTone(g.memory_used_percent)}
                  detail={`VRAM ${bytes(g.memory_used_bytes)} / ${bytes(g.memory_total_bytes)}${
                    g.power_draw_watts != null ? ` · ${Math.round(g.power_draw_watts)}W` : ''
                  }`}
                  thin
                />
              </div>
            </div>
          ))}

          {/* Footer facts: the hottest sensor and the fullest disk, the two slow-moving risks. */}
          <div className="flex items-center gap-3 font-mono text-[10px] text-slate-500">
            {hottest && (
              <span className="flex items-center gap-1" title={`${hottest.chip} ${hottest.label}`}>
                <Thermometer size={10} className={TONE_TEXT[tempTone(hottest.celsius, hottest.high_celsius, hottest.critical_celsius)]} />
                {celsius(hottest.celsius)}
              </span>
            )}
            {rootDisk && (
              <span className="flex items-center gap-1" title={`${rootDisk.label} — ${bytes(rootDisk.available_bytes)} free`}>
                <HardDrive size={10} className={TONE_TEXT[loadTone(rootDisk.used_percent)]} />
                {pct(rootDisk.used_percent)}
              </span>
            )}
            <span className="ml-auto">{live.latency_ms != null ? `${live.latency_ms}ms` : ago(live.last_ok_at)}</span>
          </div>
        </div>
      )}
    </button>
  );
}
