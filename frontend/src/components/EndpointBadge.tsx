import { useCallback, useEffect, useRef, useState } from 'react';
import { endpointsApi, type EndpointHealth } from '../lib/api';
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
/** Above this the probe round-trip reads as "slow" and the latency figure tints amber. */
const SLOW_MS = 1500;

type FleetState = 'ok' | 'degraded' | 'down' | 'unknown';

const DOT: Record<FleetState, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.45)]',
  degraded: 'bg-amber-400 shadow-[0_0_6px_2px_rgba(245,158,11,0.45)]',
  down: 'bg-red-500 shadow-[0_0_6px_2px_rgba(239,68,68,0.45)]',
  unknown: 'bg-slate-600',
};

/** The fleet-level reading: the default's health, else the first live fallback, else offline. */
function summarize(list: EndpointHealth[]): { state: FleetState; label: string; model: string } {
  const def = list.find((e) => e.is_default);
  if (def?.up) return { state: 'ok', label: def.name, model: def.model };
  const fallback = list
    .filter((e) => e.fallback_order > 0 && e.up)
    .sort((a, b) => a.fallback_order - b.fallback_order)[0];
  if (fallback) return { state: 'degraded', label: fallback.name, model: fallback.model };
  return { state: 'down', label: 'LLM offline', model: '' };
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
          ep.model && <p className="truncate font-mono text-[10px] text-slate-500">{ep.model}</p>
        ) : (
          <p className="text-[10px] text-red-400/80">unreachable</p>
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

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

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

  const s = health ? summarize(health) : { state: 'unknown' as FleetState, label: 'LLM', model: '' };

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
