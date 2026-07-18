import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, MonitorDot, Settings2 } from 'lucide-react';
import {
  endpointsApi,
  monitorApi,
  type Endpoint,
  type MonitorLive,
  type MonitorSample,
} from '../lib/api';
import { ServerCard } from '../components/monitor/ServerCard';
import { ServerDetail } from '../components/monitor/ServerDetail';
import { EmptyState } from '../components/ui';

/**
 * Monitor — the fleet dashboard over every configured `monitor-client` (see `monitor-client/`).
 *
 * Two levels, per the operator's brief: a grid of one card per machine for triage, and a drill-down
 * with every sensor the box reports. Targets are configured in Settings → Monitor.
 *
 * All telemetry comes from the backend poller's memory (`GET /monitor/live`), so this page never
 * touches the monitored machines itself: the API keys stay server-side, history survives a reload,
 * and polling faster here costs a local read, not N more requests across the LAN.
 */

/** Fast enough to feel live, cheap because it's a memory read on the backend. */
const POLL_MS = 2000;

export function MonitorView() {
  const [live, setLive] = useState<MonitorLive[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [history, setHistory] = useState<Record<string, MonitorSample[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  // Newest sample timestamp we hold per target, so each poll asks only for what it doesn't have.
  const since = useRef<Record<string, number>>({});

  const poll = useCallback(async () => {
    if (document.hidden) return;
    try {
      const next = await monitorApi.live();
      if (!mounted.current) return;
      setLive(next);
      setError(false);
      setLoaded(true);

      // History is fetched incrementally and merged; the backend holds the authoritative buffer.
      const updates = await Promise.all(
        next.map(async (t) => {
          const from = since.current[t.target_id];
          const samples = await monitorApi.history(t.target_id, from).catch(() => [] as MonitorSample[]);
          return [t.target_id, samples] as const;
        }),
      );
      if (!mounted.current) return;

      setHistory((prev) => {
        const merged = { ...prev };
        for (const [id, samples] of updates) {
          if (!samples.length) continue;
          const existing = since.current[id] ? (merged[id] ?? []) : [];
          merged[id] = [...existing, ...samples];
          since.current[id] = samples[samples.length - 1]!.t;
        }
        return merged;
      });
    } catch {
      if (mounted.current) {
        setError(true);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let timer: number | undefined;

    const start = () => {
      if (timer !== undefined) return;
      void poll();
      timer = window.setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [poll]);

  // Endpoint names are static enough to fetch once; they only label which box runs which endpoint.
  useEffect(() => {
    endpointsApi
      .list()
      .then((e) => mounted.current && setEndpoints(e))
      .catch(() => undefined);
  }, []);

  const endpointName = useCallback(
    (id: string | null) => (id ? (endpoints.find((e) => e._id === id)?.name ?? null) : null),
    [endpoints],
  );

  const alerts = useMemo(() => live.flatMap((t) => t.breaches.map((b) => ({ target: t.name, ...b }))), [live]);
  const offline = live.filter((t) => !t.online).length;
  const current = selected ? live.find((t) => t.target_id === selected) : null;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex items-center gap-3">
          <MonitorDot size={18} className="text-accent" />
          <div className="flex-1">
            <h1 className="text-base font-semibold text-slate-100">Monitor</h1>
            <p className="text-[11px] text-slate-500">
              {live.length
                ? `${live.length} machine${live.length === 1 ? '' : 's'}${
                    offline ? ` · ${offline} offline` : ''
                  }${alerts.length ? ` · ${alerts.length} threshold${alerts.length === 1 ? '' : 's'} breaching` : ''}`
                : 'Live hardware telemetry across the fleet.'}
            </p>
          </div>
          {live.some((t) => t.online) && (
            <span className="text-shimmer flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent">
              <Activity size={11} /> live
            </span>
          )}
          <Link
            to="/settings/monitor"
            title="Configure monitored machines"
            className="rounded-lg border border-white/[0.06] p-1.5 text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <Settings2 size={14} />
          </Link>
        </header>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-300">
            <AlertTriangle size={13} className="shrink-0" />
            Couldn't reach the backend monitor API.
          </div>
        )}

        {current ? (
          <ServerDetail
            live={current}
            history={history[current.target_id] ?? []}
            endpointName={endpointName(current.endpoint_id)}
            onBack={() => setSelected(null)}
          />
        ) : !loaded ? (
          <p className="text-[11px] text-slate-500">Loading…</p>
        ) : live.length === 0 ? (
          <EmptyState icon={<MonitorDot size={20} />}>
            <p>No machines are being monitored yet.</p>
            <p className="mt-1 text-slate-500">
              Deploy <code className="font-mono text-slate-400">monitor-client/</code> on a server, then add it in{' '}
              <Link to="/settings/monitor" className="text-accent hover:underline">
                Settings → Monitor
              </Link>
              .
            </p>
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {live.map((t) => (
              <ServerCard
                key={t.target_id}
                live={t}
                history={history[t.target_id] ?? []}
                endpointName={endpointName(t.endpoint_id)}
                onOpen={() => setSelected(t.target_id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
