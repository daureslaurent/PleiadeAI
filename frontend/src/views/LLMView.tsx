import { useEffect, useRef, useState } from 'react';
import { Cpu, Loader2, Star, Activity, AlertTriangle } from 'lucide-react';
import { llmApi, type LlmEndpointStats } from '../lib/api';

/**
 * LLM page: one card per inference endpoint showing the model(s) it serves and the live call
 * traffic against it — active/queued depth (calls to a single endpoint run strictly sequentially),
 * totals, tokens, and a per-model breakdown. Polls `GET /llm/stats` every 2s. Metrics are the
 * backend's in-process tallies and reset when it restarts.
 */
export function LLMView() {
  const [rows, setRows] = useState<LlmEndpointStats[] | null>(null);
  const [error, setError] = useState(false);
  // Keep the last good data on screen while a poll is in flight to avoid flicker.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const load = () =>
      llmApi
        .stats()
        .then((r) => {
          if (!mounted.current) return;
          setRows(r);
          setError(false);
        })
        .catch(() => mounted.current && setError(true));
    load();
    const id = setInterval(load, 2000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);

  if (!rows) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const totalActive = rows.reduce((n, r) => n + r.metrics.active, 0);
  const totalQueued = rows.reduce((n, r) => n + r.metrics.queued, 0);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <Activity size={13} className={totalActive > 0 ? 'text-emerald-400' : 'text-slate-500'} />
            {totalActive} streaming
          </span>
          <span>·</span>
          <span>{totalQueued} queued</span>
          {error && (
            <span className="ml-auto inline-flex items-center gap-1 text-amber-400">
              <AlertTriangle size={13} /> stats unavailable
            </span>
          )}
        </div>

        {rows.length === 0 && (
          <div className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-slate-500">
            No endpoints configured. Add one in Settings.
          </div>
        )}

        {rows
          .slice()
          .sort((a, b) => b.metrics.calls - a.metrics.calls || a.name.localeCompare(b.name))
          .map((row) => (
            <EndpointCard key={row._id} row={row} />
          ))}
      </div>
    </div>
  );
}

function EndpointCard({ row }: { row: LlmEndpointStats }) {
  const m = row.metrics;
  const busy = m.active > 0;

  return (
    <section className="rounded-lg border border-border bg-surface">
      {/* Header: name, default/fallback badges, live status dot */}
      <div className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Cpu size={16} className={busy ? 'text-emerald-400' : 'text-accent'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-slate-100">{row.name}</span>
            {row.is_default && (
              <span className="inline-flex items-center gap-0.5 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                <Star size={9} /> default
              </span>
            )}
            {row.fallback_order > 0 && (
              <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-slate-400">
                fallback #{row.fallback_order}
              </span>
            )}
            {row.unregistered && (
              <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] text-slate-400">unregistered</span>
            )}
          </div>
          <div className="truncate text-xs text-slate-500">{row.base_url}</div>
        </div>
        <LiveBadge active={m.active} queued={m.queued} />
      </div>

      {/* Aggregate counters */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-4">
        <Stat label="Calls" value={m.calls.toLocaleString()} />
        <Stat label="Errors" value={m.errors.toLocaleString()} tone={m.errors ? 'bad' : undefined} />
        <Stat label="Avg latency" value={m.avgDurationMs ? `${(m.avgDurationMs / 1000).toFixed(1)}s` : '—'} />
        <Stat label="Tokens (in/out)" value={`${fmt(m.promptTokens)} / ${fmt(m.completionTokens)}`} />
      </div>

      {/* Per-model breakdown */}
      <div className="border-t border-border px-5 py-3">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">Models</div>
        {m.byModel.length === 0 ? (
          <div className="text-xs text-slate-500">
            {row.default_model || row.models[0] ? (
              <>
                <span className="font-mono text-slate-400">{row.default_model || row.models[0]}</span> — no calls yet
              </>
            ) : (
              'no calls yet'
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="pb-1 pr-3 font-medium">Model</th>
                  <th className="pb-1 pr-3 text-right font-medium">Calls</th>
                  <th className="pb-1 pr-3 text-right font-medium">Errors</th>
                  <th className="pb-1 pr-3 text-right font-medium">Avg</th>
                  <th className="pb-1 text-right font-medium">Tokens in/out</th>
                </tr>
              </thead>
              <tbody className="font-mono text-slate-300">
                {m.byModel.map((mm) => (
                  <tr key={mm.model} className="border-t border-border/50">
                    <td className="py-1 pr-3">
                      {mm.model}
                      {row.default_model === mm.model && <span className="ml-1 text-amber-400/70">★</span>}
                    </td>
                    <td className="py-1 pr-3 text-right">{mm.calls.toLocaleString()}</td>
                    <td className={`py-1 pr-3 text-right ${mm.errors ? 'text-rose-400' : ''}`}>{mm.errors}</td>
                    <td className="py-1 pr-3 text-right">
                      {mm.avgDurationMs ? `${(mm.avgDurationMs / 1000).toFixed(1)}s` : '—'}
                    </td>
                    <td className="py-1 text-right">
                      {fmt(mm.promptTokens)}/{fmt(mm.completionTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function LiveBadge({ active, queued }: { active: number; queued: number }) {
  if (active > 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
        streaming{queued > 0 ? ` · ${queued} queued` : ''}
      </span>
    );
  }
  if (queued > 0) {
    return (
      <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-medium text-amber-400">
        {queued} queued
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-panel px-2.5 py-1 text-[11px] text-slate-400">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-500" /> idle
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-0.5 font-mono text-sm ${tone === 'bad' ? 'text-rose-400' : 'text-slate-100'}`}>{value}</div>
    </div>
  );
}

/** Compact token count: 1234 → 1.2k, 1200000 → 1.2M. */
function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
