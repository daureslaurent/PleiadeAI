import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Eye } from 'lucide-react';
import { endpointsApi, type EndpointCall, type EndpointHealth } from '../lib/api';
import { agentColor } from '../lib/agentColor';

/**
 * Header pill showing whether the LLM fleet is reachable and which endpoint agents are actually
 * hitting right now: the default endpoint's name when it's up (emerald), the effective fallback's
 * name when the default is down but a fallback answers (amber — the fleet is running degraded),
 * red "LLM offline" when nothing responds. Clicking opens a popover with every endpoint's status,
 * served model, probe latency, and the agents routed to it.
 *
 * Health comes from `GET /endpoints/health` (backend probes each server's `/v1/models`), polled
 * every 30s so a dead inference box surfaces without a page reload.
 */

const POLL_MS = 30_000;
/** Poll cadence while the popover is open — near-live activity (running call / queue). */
const OPEN_POLL_MS = 3_000;
/** Poll cadence while closed but a call is streaming/queued, so the pill's pulse doesn't go stale. */
const BUSY_POLL_MS = 5_000;
/** Above this the probe round-trip reads as "slow" and the latency figure tints amber. */
const SLOW_MS = 1500;

/** Amber glow for the "streaming" pulse (DIRECT_ART: liveness breathes via --glow). */
const AMBER_GLOW = { '--glow': 'rgba(245,158,11,0.45)' } as CSSProperties;

/** Compact elapsed/wait time: `8s`, then `1:23` past a minute. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type FleetState = 'ok' | 'degraded' | 'down' | 'unknown';

const DOT: Record<FleetState, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.45)]',
  degraded: 'bg-amber-400 shadow-[0_0_6px_2px_rgba(245,158,11,0.45)]',
  down: 'bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.45)]',
  unknown: 'bg-slate-600',
};

/** The fleet-level reading: the default's health, else the first live fallback, else offline. */
function summarize(list: EndpointHealth[]): {
  state: FleetState;
  label: string;
  model: string;
  vision: boolean;
} {
  const def = list.find((e) => e.is_default);
  if (def?.up) return { state: 'ok', label: def.name, model: def.model, vision: def.vision };
  const fallback = list
    .filter((e) => e.fallback_order > 0 && e.up)
    .sort((a, b) => a.fallback_order - b.fallback_order)[0];
  if (fallback) {
    return { state: 'degraded', label: fallback.name, model: fallback.model, vision: fallback.vision };
  }
  return { state: 'down', label: 'LLM offline', model: '', vision: false };
}

/** Sky "eye" pin marking a vision-capable (multimodal) model. */
function VisionPin({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center text-sky-400 ${className}`}
      title="Vision-capable model — images are attached to inference"
    >
      <Eye size={11} aria-label="vision-capable" />
    </span>
  );
}

function Latency({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  return (
    <span
      className={`font-mono tabular-nums text-[10px] ${ms > SLOW_MS ? 'text-amber-400' : 'text-slate-500'}`}
      title="Health-probe round-trip"
    >
      {ms}ms
    </span>
  );
}

/**
 * One gate call: the streaming one gets the pulsing amber dot, queued ones their FIFO position.
 * The agent renders in its identity color; agent-less side tasks fall back to their source label.
 */
function CallLine({ call, position, agents }: { call: EndpointCall; position?: number; agents: EndpointHealth['agents'] }) {
  const running = position === undefined;
  const c = call.agent ? agentColor(call.agent, agents.find((a) => a.name === call.agent)?.color ?? null) : null;
  return (
    <div className="flex items-center gap-1.5 text-[10px]" title={`${call.model} — ${call.source}`}>
      {running ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-glow-pulse rounded-full bg-amber-400" style={AMBER_GLOW} />
      ) : (
        <span className="w-1.5 shrink-0 text-center font-mono text-slate-600">{position}</span>
      )}
      <span className="truncate" style={c ? { color: c.accent } : undefined}>
        {call.agent ?? <span className="text-slate-400">{call.source}</span>}
      </span>
      {call.agent && (
        <span className="rounded bg-white/[0.06] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-slate-500">
          {call.source}
        </span>
      )}
      <span
        className={`ml-auto shrink-0 font-mono tabular-nums ${running ? 'text-amber-400/80' : 'text-slate-600'}`}
        title={running ? 'Streaming for' : 'Waiting for'}
      >
        {fmtElapsed(call.elapsed_ms)}
      </span>
    </div>
  );
}

function EndpointRow({ ep }: { ep: EndpointHealth }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-2">
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ep.up ? DOT.ok : DOT.down}`} />
        <span className="truncate text-xs font-medium text-slate-200">{ep.name}</span>
        {ep.is_default && (
          <span className="rounded bg-accent/15 px-1 py-px text-[9px] font-mono uppercase tracking-wide text-accent">
            default
          </span>
        )}
        {ep.fallback_order > 0 && (
          <span
            className="rounded bg-white/[0.06] px-1 py-px text-[9px] font-mono uppercase tracking-wide text-slate-500"
            title="Position in the failover chain"
          >
            fb {ep.fallback_order}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <Latency ms={ep.latency_ms} />
        </span>
      </div>
      <div className="mt-1 pl-3.5">
        {ep.up ? (
          ep.model && (
            <p className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
              <span className="truncate">{ep.model}</span>
              {ep.vision && <VisionPin />}
            </p>
          )
        ) : (
          <p className="text-[10px] text-red-400/80">unreachable</p>
        )}
        {(ep.running || ep.queue.length > 0) && (
          <div className="mt-1 space-y-0.5">
            {ep.running && <CallLine call={ep.running} agents={ep.agents} />}
            {ep.queue.map((q, i) => (
              <CallLine key={i} call={q} position={i + 1} agents={ep.agents} />
            ))}
          </div>
        )}
        {ep.agents.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {ep.agents.map((a) => {
              const c = agentColor(a.name, a.color);
              return (
                <span
                  key={a.name}
                  className="rounded-md border px-1 py-px text-[10px]"
                  style={{ color: c.accent, borderColor: c.border, background: c.soft }}
                  title={`${a.name} routes its inference here`}
                >
                  {a.name}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function EndpointBadge() {
  const [health, setHealth] = useState<EndpointHealth[] | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    endpointsApi
      .health()
      .then(setHealth)
      .catch(() => {
        // Backend unreachable — keep the last reading rather than flashing "offline" on a blip.
      });
  }, []);

  const runningCount = health?.filter((e) => e.running).length ?? 0;
  const queuedCount = health?.reduce((n, e) => n + e.queue.length, 0) ?? 0;
  const busy = runningCount > 0 || queuedCount > 0;

  // Adaptive cadence: near-live while the popover is open, a bit faster while a call is streaming
  // (so the pill's pulse and the elapsed times don't go stale), lazy 30s otherwise.
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(refresh, open ? OPEN_POLL_MS : busy ? BUSY_POLL_MS : POLL_MS);
    return () => clearInterval(t);
  }, [refresh, open, busy]);

  // Opening the popover is "the operator wants to know now" — don't serve a 30s-stale reading.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Dismiss on outside click / Escape — same transient-popover contract as MemoriesBadge.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (health !== null && health.length === 0) return null;

  const s = health
    ? summarize(health)
    : { state: 'unknown' as FleetState, label: 'LLM', model: '', vision: false };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          s.state === 'ok'
            ? `Inference is served by ${s.label}`
            : s.state === 'degraded'
              ? `Default endpoint is down — running degraded on ${s.label}`
              : s.state === 'down'
                ? 'No inference endpoint is reachable'
                : 'Probing inference endpoints…'
        }
        className={[
          'flex h-7 items-center gap-2 rounded-full border px-2.5 text-xs transition-colors',
          open
            ? 'border-white/[0.12] bg-white/[0.06]'
            : 'border-white/[0.07] bg-white/[0.03] hover:border-white/[0.12] hover:bg-white/[0.05]',
        ].join(' ')}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[s.state]}`} />
        <span
          className={
            s.state === 'down'
              ? 'text-red-400'
              : s.state === 'degraded'
                ? 'text-amber-300'
                : 'text-slate-300'
          }
        >
          {s.label}
        </span>
        {s.state === 'degraded' && (
          <span className="text-[10px] uppercase tracking-wide text-amber-400/80">fallback</span>
        )}
        {s.model && (
          <span className="hidden max-w-40 truncate font-mono text-[10px] text-slate-500 sm:block">
            {s.model}
          </span>
        )}
        {s.vision && <VisionPin className="hidden sm:inline-flex" />}
        {runningCount > 0 && (
          <span
            className="flex items-center gap-1"
            title={`${runningCount} LLM call${runningCount > 1 ? 's' : ''} streaming${queuedCount ? `, ${queuedCount} queued` : ''}`}
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-glow-pulse rounded-full bg-amber-400" style={AMBER_GLOW} />
            {queuedCount > 0 && (
              <span className="font-mono text-[10px] tabular-nums text-amber-400/90">+{queuedCount}</span>
            )}
          </span>
        )}
      </button>

      {open && health && (
        <div
          role="dialog"
          aria-label="Inference endpoint health"
          className="glass-popover absolute right-0 top-full z-30 mt-1.5 w-[min(22rem,calc(100vw-3rem))] animate-fade-up rounded-2xl border p-2.5"
        >
          <p className="mb-2 px-0.5 text-[10px] uppercase tracking-wide text-slate-500">
            Inference endpoints
          </p>
          <div className="max-h-96 space-y-1.5 overflow-y-auto">
            {health.map((ep) => (
              <EndpointRow key={ep._id} ep={ep} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
