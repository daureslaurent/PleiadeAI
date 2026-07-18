import { AlertTriangle, ArrowLeft, Cpu, Fan, HardDrive, Network, Thermometer, Zap } from 'lucide-react';
import type { MonitorLive, MonitorSample } from '../../lib/api';
import { Meter, Sparkline } from './Meter';
import {
  TONE_TEXT,
  ago,
  breachTone,
  bytes,
  celsius,
  loadTone,
  pct,
  rate,
  tempTone,
  uptime,
  type Tone,
} from './format';

/**
 * Drill-down for one machine: everything the monitor-client reported, grouped the way you diagnose —
 * what's breaching, then compute (CPU + per-core), then each GPU, then the slow-moving stuff
 * (sensors, fans, disks, NICs).
 *
 * Sections render only when their data exists. The client degrades per-section (a box with no fan
 * chip reports none), so an absent section is normal and its `warnings` entry already explains why —
 * an empty "Fans" panel would be noise.
 */
export function ServerDetail({
  live,
  history,
  endpointName,
  onBack,
}: {
  live: MonitorLive;
  history: MonitorSample[];
  endpointName: string | null;
  onBack: () => void;
}) {
  const snap = live.snapshot;
  const tone = live.online ? breachTone(live.breaches) : 'critical';

  const series = (pick: (s: MonitorSample) => number | null): [number, number | null][] =>
    history.map((s) => [s.t, pick(s)]);

  // Network is plotted against its own observed peak: rates have no natural ceiling, and a fixed one
  // would flatten every real transfer into an invisible line at the bottom.
  const netPeak = Math.max(1, ...history.flatMap((s) => [s.rx ?? 0, s.tx ?? 0]));

  return (
    <div className="animate-fade-up space-y-4">
      <header className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
        >
          <ArrowLeft size={13} /> Fleet
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-slate-100">{live.name}</h2>
            {endpointName && (
              <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">{endpointName}</span>
            )}
            <span className={`text-[11px] ${TONE_TEXT[tone]}`}>{live.online ? 'online' : 'offline'}</span>
          </div>
          <p className="truncate font-mono text-[11px] text-slate-500">
            {snap?.host?.hostname ?? '—'} · {snap?.host?.os ?? '—'} · {snap?.host?.kernel ?? '—'} · up{' '}
            {uptime(snap?.host?.uptime_sec)} · read {ago(live.last_ok_at)}
          </p>
        </div>
      </header>

      {live.note && <p className="text-xs text-slate-400">{live.note}</p>}

      {!live.online && (
        <Panel tone="critical">
          <div className="flex items-center gap-2 text-[11px] text-red-300">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="break-words font-mono">{live.error}</span>
          </div>
          <p className="mt-1 text-[10px] text-slate-500">
            Showing the last reading from {ago(live.last_ok_at)}.
          </p>
        </Panel>
      )}

      {live.breaches.length > 0 && live.online && (
        <Panel tone={breachTone(live.breaches)}>
          <SectionLabel>Breaching thresholds</SectionLabel>
          <ul className="space-y-1">
            {live.breaches.map((b) => (
              <li key={b.key} className="flex items-center gap-2 text-[11px]">
                <AlertTriangle
                  size={11}
                  className={b.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}
                />
                <span className="text-slate-300">{b.label}</span>
                <span className="ml-auto font-mono text-slate-400">
                  {b.value ?? '—'} / limit {b.limit ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {snap?.warnings?.length ? (
        <Panel>
          <SectionLabel>Sensors unavailable on this host</SectionLabel>
          <ul className="space-y-0.5 font-mono text-[10px] text-slate-500">
            {snap.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {!snap ? (
        <Panel>
          <p className="text-[11px] text-slate-500">No reading yet.</p>
        </Panel>
      ) : (
        <>
          {/* --- Compute --- */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <SectionLabel icon={<Cpu size={11} />}>CPU</SectionLabel>
              <p className="mb-2 truncate text-[11px] text-slate-400" title={snap.cpu?.model ?? ''}>
                {snap.cpu?.model ?? 'unknown'} · {snap.cpu?.cores ?? '?'}c/{snap.cpu?.threads ?? '?'}t
              </p>
              <Sparkline points={series((s) => s.cpu)} tone={loadTone(snap.cpu?.usage_percent)} height={48} />
              <div className="mt-2 grid grid-cols-3 gap-2">
                <Stat label="Usage" value={pct(snap.cpu?.usage_percent)} tone={loadTone(snap.cpu?.usage_percent)} />
                <Stat
                  label="Package"
                  value={celsius(snap.cpu?.temperature_celsius)}
                  tone={tempTone(snap.cpu?.temperature_celsius ?? null)}
                />
                <Stat
                  label="Load 1m"
                  value={snap.cpu?.load_average?.['1m']?.toFixed(2) ?? '—'}
                  tone="idle"
                />
              </div>

              {snap.cpu?.per_core_percent?.length ? (
                <div className="mt-3">
                  <SectionLabel>Per core</SectionLabel>
                  <div className="grid grid-cols-8 gap-1">
                    {snap.cpu.per_core_percent.map((c, i) => (
                      <div key={i} title={`core ${i}: ${pct(c)}${
                        snap.cpu.frequencies_mhz?.[i] != null ? ` @ ${Math.round(snap.cpu.frequencies_mhz[i]!)} MHz` : ''
                      }`}>
                        <Meter value={c} tone={loadTone(c)} thin />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Panel>

            <Panel>
              <SectionLabel>Memory</SectionLabel>
              <Sparkline points={series((s) => s.mem)} tone={loadTone(snap.memory?.used_percent)} height={48} />
              <div className="mt-2 space-y-2">
                <Meter
                  label="RAM"
                  value={snap.memory?.used_percent ?? null}
                  tone={loadTone(snap.memory?.used_percent)}
                  detail={`${bytes(snap.memory?.used_bytes)} used · ${bytes(
                    snap.memory?.available_bytes,
                  )} available of ${bytes(snap.memory?.total_bytes)}`}
                />
                {snap.memory?.swap_total_bytes ? (
                  <Meter
                    label="Swap"
                    value={
                      snap.memory.swap_total_bytes
                        ? ((snap.memory.swap_used_bytes ?? 0) / snap.memory.swap_total_bytes) * 100
                        : null
                    }
                    tone={loadTone(
                      snap.memory.swap_total_bytes
                        ? ((snap.memory.swap_used_bytes ?? 0) / snap.memory.swap_total_bytes) * 100
                        : null,
                    )}
                    detail={`${bytes(snap.memory.swap_used_bytes)} / ${bytes(snap.memory.swap_total_bytes)}`}
                    thin
                  />
                ) : null}
              </div>
            </Panel>
          </div>

          {/* --- GPUs --- */}
          {snap.gpus.map((g, i) => (
            <Panel key={g.uuid ?? g.index}>
              <SectionLabel icon={<Zap size={11} />}>
                GPU{g.index} · {g.name ?? 'unknown'} {g.pstate ? `· ${g.pstate}` : ''}
              </SectionLabel>
              <div className="grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Utilization</p>
                  <Sparkline
                    points={series((s) => s.gpu_util[i] ?? null)}
                    tone={loadTone(g.utilization_percent)}
                    height={40}
                  />
                </div>
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">VRAM</p>
                  <Sparkline
                    points={series((s) => s.gpu_vram[i] ?? null)}
                    tone={loadTone(g.memory_used_percent)}
                    height={40}
                  />
                </div>
              </div>
              <div className="mt-3 space-y-2">
                <Meter label="Core" value={g.utilization_percent} tone={loadTone(g.utilization_percent)} />
                <Meter
                  label="VRAM"
                  value={g.memory_used_percent}
                  tone={loadTone(g.memory_used_percent)}
                  detail={`${bytes(g.memory_used_bytes)} / ${bytes(g.memory_total_bytes)}`}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Temp" value={celsius(g.temperature_celsius)} tone={tempTone(g.temperature_celsius)} />
                <Stat
                  label="Power"
                  value={
                    g.power_draw_watts != null
                      ? `${Math.round(g.power_draw_watts)}${g.power_limit_watts ? `/${Math.round(g.power_limit_watts)}` : ''}W`
                      : '—'
                  }
                  tone={loadTone(
                    g.power_draw_watts != null && g.power_limit_watts
                      ? (g.power_draw_watts / g.power_limit_watts) * 100
                      : null,
                  )}
                />
                {/* Null fan% means the card has no fan to report (datacenter/passive), not a failure. */}
                <Stat label="Fan" value={g.fan_percent != null ? `${g.fan_percent}%` : 'passive'} tone="idle" />
                <Stat
                  label="Clocks"
                  value={g.clock_sm_mhz != null ? `${g.clock_sm_mhz}/${g.clock_mem_mhz ?? '—'} MHz` : '—'}
                  tone="idle"
                />
              </div>
            </Panel>
          ))}

          {/* --- Slow-moving: sensors, fans, disks, network --- */}
          <div className="grid gap-4 lg:grid-cols-2">
            {snap.temperatures.length > 0 && (
              <Panel>
                <SectionLabel icon={<Thermometer size={11} />}>Temperatures</SectionLabel>
                <ul className="space-y-1.5">
                  {snap.temperatures.map((t, i) => (
                    <li key={`${t.chip}-${t.label}-${i}`} className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 shrink-0 truncate font-mono text-slate-500">{t.chip}</span>
                      <span className="truncate text-slate-400">{t.label}</span>
                      <span
                        className={`ml-auto shrink-0 font-mono ${
                          TONE_TEXT[tempTone(t.celsius, t.high_celsius, t.critical_celsius)]
                        }`}
                      >
                        {celsius(t.celsius)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {snap.fans.length > 0 && (
              <Panel>
                <SectionLabel icon={<Fan size={11} />}>Fans</SectionLabel>
                <ul className="space-y-1.5">
                  {snap.fans.map((f, i) => (
                    <li key={`${f.chip}-${f.label}-${i}`} className="flex items-center gap-2 text-[11px]">
                      <span className="w-20 shrink-0 truncate font-mono text-slate-500">{f.chip}</span>
                      <span className="truncate text-slate-400">{f.label}</span>
                      <span className="ml-auto shrink-0 font-mono text-slate-300">
                        {f.rpm != null ? `${f.rpm} rpm` : '—'}
                        {f.duty_percent != null ? ` · ${Math.round(f.duty_percent)}%` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {snap.disks.length > 0 && (
              <Panel>
                <SectionLabel icon={<HardDrive size={11} />}>Disks</SectionLabel>
                <div className="space-y-2.5">
                  {snap.disks.map((d) => (
                    <div key={d.label}>
                      {d.error ? (
                        <p className="text-[11px] text-slate-500">
                          <span className="font-mono text-slate-400">{d.label}</span> — {d.error}
                        </p>
                      ) : (
                        <Meter
                          label={d.label}
                          value={d.used_percent ?? null}
                          tone={loadTone(d.used_percent)}
                          detail={`${bytes(d.used_bytes)} used · ${bytes(d.available_bytes)} free of ${bytes(
                            d.total_bytes,
                          )}`}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {Object.keys(snap.network).length > 0 && (
              <Panel>
                <SectionLabel icon={<Network size={11} />}>Network</SectionLabel>
                <div className="mb-2 grid grid-cols-2 gap-3">
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Down</p>
                    <Sparkline points={series((s) => s.rx)} tone="ok" max={netPeak} height={34} />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Up</p>
                    <Sparkline points={series((s) => s.tx)} tone="ok" max={netPeak} height={34} />
                  </div>
                </div>
                <ul className="space-y-1">
                  {Object.entries(snap.network).map(([name, n]) => (
                    <li key={name} className="flex items-center gap-2 font-mono text-[10px]">
                      <span className="w-16 shrink-0 truncate text-slate-400">{name}</span>
                      <span className="text-slate-500">↓ {rate(n.rx_bytes_per_sec)}</span>
                      <span className="text-slate-500">↑ {rate(n.tx_bytes_per_sec)}</span>
                      <span className="ml-auto text-slate-600">
                        {bytes(n.rx_bytes)} / {bytes(n.tx_bytes)} total
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** In-flow glass panel — lightweight per DIRECT_ART §3 (no heavy blur stacked across many cards). */
function Panel({ children, tone }: { children: React.ReactNode; tone?: Tone }) {
  const border =
    tone === 'critical' ? 'border-red-500/25' : tone === 'warn' ? 'border-amber-500/25' : 'border-white/[0.06]';
  return <section className={`rounded-2xl border ${border} bg-white/[0.03] p-4 backdrop-blur-sm`}>{children}</section>;
}

function SectionLabel({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-500">
      {icon}
      {children}
    </h3>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="rounded-lg bg-black/20 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`font-mono text-xs ${TONE_TEXT[tone]}`}>{value}</div>
    </div>
  );
}
