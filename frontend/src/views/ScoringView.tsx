import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Play, Download, RefreshCw, Gauge, AlertTriangle } from 'lucide-react';
import {
  scoringApi,
  type ConversationScore,
  type ScoringSummary,
  type ScoreTag,
} from '../lib/api';
import { getSocket } from '../lib/socket';
import { ScoreBadge } from '../components/ScoreBadge';
import type { TurnScoredEvent } from '../lib/ws-events.types';

/**
 * Conversation Quality Scorer dashboard: dataset-health summary, batch scoring (unscored-only vs
 * re-score, sequential vs parallel), JSONL export/download, and the scored-turn list with a tag
 * filter. New scores stream in live via the `turn_scored` socket event (llama-log room).
 */
const TAGS: ScoreTag[] = ['Perfect', 'Patched', 'Recovered', 'Rejected'];

export function ScoringView() {
  const [summary, setSummary] = useState<ScoringSummary | null>(null);
  const [scores, setScores] = useState<ConversationScore[] | null>(null);
  const [tagFilter, setTagFilter] = useState<ScoreTag | ''>('');
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  const load = useMemo(
    () => async () => {
      try {
        const [sum, list] = await Promise.all([
          scoringApi.summary(),
          scoringApi.list({ tag: tagFilter || undefined, limit: 300 }),
        ]);
        if (!mounted.current) return;
        setSummary(sum);
        setScores(list);
        setError(false);
      } catch {
        if (mounted.current) setError(true);
      }
    },
    [tagFilter],
  );

  useEffect(() => {
    mounted.current = true;
    void load();
    // Live: a newly-scored turn (re)loads the list so it appears without a manual refresh.
    const socket = getSocket();
    socket.emit('llama:subscribe');
    const onScored = (_e: TurnScoredEvent) => void load();
    socket.on('turn_scored', onScored);
    return () => {
      mounted.current = false;
      socket.off('turn_scored', onScored);
    };
  }, [load]);

  return (
    <div className="space-bg h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <SummaryBar summary={summary} error={error} />
        <Controls onDone={load} />

        {/* Tag filter */}
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[11px] uppercase tracking-wider text-slate-500">Filter</span>
          <FilterChip active={tagFilter === ''} onClick={() => setTagFilter('')}>
            All
          </FilterChip>
          {TAGS.map((t) => (
            <FilterChip key={t} active={tagFilter === t} onClick={() => setTagFilter(t)}>
              {t}
            </FilterChip>
          ))}
        </div>

        {!scores ? (
          <div className="flex h-40 items-center justify-center text-slate-500">
            <Loader2 className="animate-spin" />
          </div>
        ) : scores.length === 0 ? (
          <div className="glass-card rounded-2xl border border-white/[0.06] p-8 text-center text-sm text-slate-500">
            No scored turns yet. Enable auto-scoring in Settings, or run a batch above.
          </div>
        ) : (
          <div className="space-y-2">
            {scores.map((s) => (
              <ScoreRow key={s.turnId} score={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryBar({ summary, error }: { summary: ScoringSummary | null; error: boolean }) {
  return (
    <div className="glass-card flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.06] px-4 py-3">
      <Gauge size={15} className="text-accent" />
      <span className="text-sm font-semibold text-slate-100">Dataset quality</span>
      {error && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
          <AlertTriangle size={12} /> unavailable
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Pill label="Scored" value={summary ? String(summary.total) : '—'} />
        <Pill label="Avg" value={summary ? String(summary.avgScore) : '—'} tone="accent" />
        {TAGS.map((t) => (
          <Pill key={t} label={t} value={summary ? String(summary.byTag[t] ?? 0) : '—'} />
        ))}
      </div>
    </div>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone?: 'accent' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
        tone === 'accent'
          ? 'border-accent/25 bg-accent/10 text-accent'
          : 'border-white/[0.07] bg-white/[0.03] text-slate-400'
      }`}
    >
      <span className="uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-mono text-slate-100">{value}</span>
    </span>
  );
}

function Controls({ onDone }: { onDone: () => Promise<void> | void }) {
  const [mode, setMode] = useState<'unscored' | 'rescore'>('unscored');
  const [parallel, setParallel] = useState(true);
  const [busy, setBusy] = useState<'batch' | 'export' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const runBatch = async () => {
    setBusy('batch');
    setMsg(null);
    try {
      const r = await scoringApi.scoreAll({ mode, concurrency: parallel ? 4 : 1 });
      setMsg(`Scored ${r.scored}, skipped ${r.skipped}, failed ${r.failed} of ${r.total}.`);
      await onDone();
    } catch {
      setMsg('Batch failed.');
    } finally {
      setBusy(null);
    }
  };

  const runExport = async () => {
    setBusy('export');
    setMsg(null);
    try {
      const blob = await scoringApi.downloadBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sft-export-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg('Export downloaded (also written to the server).');
    } catch {
      setMsg('Export failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="glass-card flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-white/[0.06] px-4 py-3">
      {/* Mode */}
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-[11px] uppercase tracking-wider text-slate-500">Batch</span>
        <Seg active={mode === 'unscored'} onClick={() => setMode('unscored')}>
          Unscored only
        </Seg>
        <Seg active={mode === 'rescore'} onClick={() => setMode('rescore')}>
          Re-score all
        </Seg>
      </div>
      {/* Concurrency */}
      <div className="flex items-center gap-1.5">
        <Seg active={!parallel} onClick={() => setParallel(false)}>
          Sequential
        </Seg>
        <Seg active={parallel} onClick={() => setParallel(true)}>
          Parallel
        </Seg>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={runBatch}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent ring-1 ring-accent/40 transition hover:bg-accent/30 disabled:opacity-50"
        >
          {busy === 'batch' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          Score now
        </button>
        <button
          onClick={runExport}
          disabled={busy !== null}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/[0.1] transition hover:bg-white/[0.06] disabled:opacity-50"
        >
          {busy === 'export' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          Export JSONL
        </button>
      </div>

      {msg && (
        <div className="flex w-full items-center gap-1.5 border-t border-white/[0.06] pt-2 text-[11px] text-slate-400">
          <RefreshCw size={11} /> {msg}
        </div>
      )}
    </div>
  );
}

function ScoreRow({ score }: { score: ConversationScore }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/25 px-3 py-2.5 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <ScoreBadge score={score} size="sm" />
        <span className="font-mono text-[11px] text-slate-500">{score.turnId.slice(0, 8)}</span>
        <span className="text-[10px] uppercase tracking-wider text-slate-600">{score.origin}</span>
        <span className="ml-auto font-mono text-[10px] text-slate-600">{score.judgeModel}</span>
      </div>
      {score.explanation && (
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{score.explanation}</p>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
        active ? 'bg-accent/20 text-accent ring-1 ring-accent/40' : 'text-slate-400 hover:bg-white/[0.05]'
      }`}
    >
      {children}
    </button>
  );
}

function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
        active ? 'bg-white/[0.1] text-slate-100 ring-1 ring-white/[0.15]' : 'text-slate-400 hover:bg-white/[0.05]'
      }`}
    >
      {children}
    </button>
  );
}
