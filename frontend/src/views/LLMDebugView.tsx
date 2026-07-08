import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  Check,
  Copy,
  ChevronRight,
  Database,
  Trash2,
  Zap,
  CircleAlert,
} from 'lucide-react';
import {
  llmDebugApi,
  type LlamaCallRecord,
  type LlamaLogStats,
  type ScoreTag,
} from '../lib/api';
import { useLlamaDebug, type LiveCall, type DebugScore } from '../store/llamaDebug';
import { agentColor } from '../lib/agentColor';
import { ScoreBadge } from '../components/ScoreBadge';

/**
 * LLM Debug page — the last N raw HTTP calls to the inference server, each with its full request and
 * response. A call streams live at the top as it happens (socket `llama-log` feed) then settles into
 * the persisted list (re-fetched from Mongo on refresh). Also shows the DB storage used by the two
 * capture tiers and a guarded archive purge.
 */
export function LLMDebugView() {
  const { records, live, scores, limit, loading, error, wire, hydrate, setLimit } = useLlamaDebug();
  const [stats, setStats] = useState<LlamaLogStats | null>(null);
  const [tagFilter, setTagFilter] = useState<ScoreTag | ''>('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    wire();
    void hydrate();
    const loadStats = () =>
      llmDebugApi
        .stats()
        .then((s) => mounted.current && setStats(s))
        .catch(() => undefined);
    loadStats();
    const id = setInterval(loadStats, 5000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const liveCalls = useMemo(
    () => Object.values(live).sort((a, b) => b.startedAt - a.startedAt),
    [live],
  );

  // Optional filter: show only records whose run was scored with the chosen tag.
  const shownRecords = useMemo(
    () => (tagFilter ? records.filter((r) => r.runId && scores[r.runId]?.tag === tagFilter) : records),
    [records, scores, tagFilter],
  );

  const onPurge = async () => {
    if (!window.confirm('Purge the entire archive? This permanently deletes all stored calls (including future fine-tuning data). The capped debug view is unaffected.')) return;
    await llmDebugApi.purgeArchive();
    await hydrate();
    setStats(await llmDebugApi.stats().catch(() => null));
  };

  return (
    <div className="space-bg h-full overflow-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <Toolbar
          limit={limit}
          onLimit={setLimit}
          stats={stats}
          error={error}
          liveCount={liveCalls.length}
          onPurge={onPurge}
        />

        {/* Score tag filter — narrows the list to records whose turn earned a given ruling. */}
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[11px] uppercase tracking-wider text-slate-500">Score</span>
          <TagChip active={tagFilter === ''} onClick={() => setTagFilter('')}>
            All
          </TagChip>
          {(['Perfect', 'Patched', 'Recovered', 'Rejected'] as ScoreTag[]).map((t) => (
            <TagChip key={t} active={tagFilter === t} onClick={() => setTagFilter(t)}>
              {t}
            </TagChip>
          ))}
        </div>

        {loading && records.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-slate-500">
            <Loader2 className="animate-spin" />
          </div>
        ) : (
          <div className="space-y-3">
            {liveCalls.map((call) => (
              <LiveCard key={call.id} call={call} />
            ))}

            {shownRecords.length === 0 && liveCalls.length === 0 && (
              <div className="glass-card rounded-2xl border border-white/[0.06] p-8 text-center text-sm text-slate-500">
                {tagFilter
                  ? `No ${tagFilter} turns in the current records.`
                  : "No calls captured yet. Send a message in the Workspace and they'll appear here."}
              </div>
            )}

            {shownRecords.map((rec) => (
              <RecordCard key={rec.id + rec.createdAt} rec={rec} score={rec.runId ? scores[rec.runId] : undefined} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar: count control, DB size pills, purge
// ---------------------------------------------------------------------------

function Toolbar({
  limit,
  onLimit,
  stats,
  error,
  liveCount,
  onPurge,
}: {
  limit: number;
  onLimit: (n: number) => void;
  stats: LlamaLogStats | null;
  error: boolean;
  liveCount: number;
  onPurge: () => void;
}) {
  const isPreset = limit === 10 || limit === 50;
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const [customVal, setCustomVal] = useState(String(isPreset ? 100 : limit));

  const applyCustom = () => {
    const n = Math.min(Math.max(Math.trunc(Number(customVal) || 0), 1), 1000);
    setCustomVal(String(n));
    onLimit(n);
  };

  return (
    <div className="glass-card flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-white/[0.06] px-4 py-3">
      {/* Count control */}
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-[11px] uppercase tracking-wider text-slate-500">Show</span>
        {[10, 50].map((n) => (
          <button
            key={n}
            onClick={() => {
              setCustomOpen(false);
              onLimit(n);
            }}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
              !customOpen && limit === n
                ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
                : 'text-slate-400 hover:bg-white/[0.05]'
            }`}
          >
            {n}
          </button>
        ))}
        <button
          onClick={() => setCustomOpen(true)}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
            customOpen ? 'bg-accent/20 text-accent ring-1 ring-accent/40' : 'text-slate-400 hover:bg-white/[0.05]'
          }`}
        >
          Custom
        </button>
        {customOpen && (
          <input
            type="number"
            min={1}
            max={1000}
            value={customVal}
            onChange={(e) => setCustomVal(e.target.value)}
            onBlur={applyCustom}
            onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
            className="w-16 rounded-lg border border-white/[0.08] bg-black/30 px-2 py-1 text-xs text-slate-100 focus:border-accent/50 focus:outline-none"
            title=">50 pages the durable archive"
          />
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        {liveCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            {liveCount} live
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle size={12} /> feed unavailable
          </span>
        )}
      </div>

      {/* DB size readout */}
      <div className="flex w-full flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
        <Database size={13} className="text-slate-500" />
        <SizePill label="Archive" bytes={stats?.archive.bytes} count={stats?.archive.count} tone="accent" />
        <SizePill label="Debug (capped)" bytes={stats?.debug.bytes} count={stats?.debug.count} />
        <SizePill label="Total DB" bytes={stats?.dbBytes} />
        <button
          onClick={onPurge}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-400 transition hover:bg-red-500/15 hover:text-red-400"
          title="Permanently delete the durable archive"
        >
          <Trash2 size={12} /> Purge archive
        </button>
      </div>
    </div>
  );
}

function SizePill({
  label,
  bytes,
  count,
  tone,
}: {
  label: string;
  bytes?: number;
  count?: number;
  tone?: 'accent';
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
        tone === 'accent' ? 'border-accent/25 bg-accent/10 text-accent' : 'border-white/[0.07] bg-white/[0.03] text-slate-400'
      }`}
    >
      <span className="uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-mono text-slate-100">{bytes == null ? '—' : fmtBytes(bytes)}</span>
      {count != null && <span className="font-mono opacity-60">· {count}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Live in-progress card
// ---------------------------------------------------------------------------

function LiveCard({ call }: { call: LiveCall }) {
  const color = agentColor(call.agent ?? call.source);
  return (
    <div className="glass-card animate-glow-pulse rounded-2xl border border-emerald-400/20 p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/15 px-2.5 py-1 text-[11px] font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          streaming
        </span>
        <SourceTag source={call.source} />
        <span className="font-mono text-xs text-slate-300" style={{ color: color.accent }}>
          {call.agent ?? call.source}
        </span>
        <span className="truncate font-mono text-[11px] text-slate-500">{call.model}</span>
      </div>
      <div className="rounded-xl bg-black/30 p-3 backdrop-blur-sm">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">Response (live)</div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-300">
          {call.text || <span className="text-slate-600">waiting for first token…</span>}
        </pre>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persisted record card (collapsible)
// ---------------------------------------------------------------------------

function RecordCard({ rec, score }: { rec: LlamaCallRecord; score?: DebugScore }) {
  const [open, setOpen] = useState(false);
  const [rawChunks, setRawChunks] = useState<string[] | null>(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const color = agentColor(rec.agentName ?? rec.source);
  const err = rec.status === 'error';

  const loadRaw = async () => {
    if (rawChunks) {
      setRawChunks(null);
      return;
    }
    setLoadingRaw(true);
    try {
      const detail = await llmDebugApi.get(rec.id);
      setRawChunks(detail.rawChunks ?? []);
    } catch {
      setRawChunks([]);
    } finally {
      setLoadingRaw(false);
    }
  };

  return (
    <div
      className={`rounded-xl border bg-black/25 backdrop-blur-sm transition ${
        err ? 'border-red-500/25 ring-1 ring-red-500/10' : 'border-white/[0.06]'
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <ChevronRight
          size={14}
          className={`shrink-0 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <SourceTag source={rec.source} />
        <span className="shrink-0 font-mono text-xs" style={{ color: color.accent }}>
          {rec.agentName ?? rec.source}
        </span>
        <span className="truncate font-mono text-[11px] text-slate-500">{rec.model}</span>
        <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px] text-slate-500">
          {score && <ScoreBadge score={score} size="xs" />}
          {rec.usage && (
            <span className="font-mono" title="prompt / completion tokens">
              {rec.usage.promptTokens}↑ {rec.usage.completionTokens}↓
            </span>
          )}
          <span className="inline-flex items-center gap-1 font-mono">
            <Zap size={11} className="text-slate-600" />
            {fmtMs(rec.durationMs)}
          </span>
          {err ? (
            <CircleAlert size={13} className="text-red-400" />
          ) : (
            <Check size={13} className="text-emerald-400/70" />
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-white/[0.06] px-3 py-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
            <Meta k="endpoint" v={rec.endpoint} />
            {rec.sessionId && <Meta k="session" v={rec.sessionId} />}
            {rec.firstTokenMs != null && <Meta k="ttft" v={fmtMs(rec.firstTokenMs)} />}
            <Meta k="at" v={new Date(rec.createdAt).toLocaleString()} />
          </div>

          {err && rec.error && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {rec.error}
            </div>
          )}

          <JsonPanel label="Request" value={rec.request} />
          <JsonPanel label="Response" value={rec.response} />

          <div>
            <button
              onClick={loadRaw}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/[0.05]"
            >
              {loadingRaw ? <Loader2 size={12} className="animate-spin" /> : <ChevronRight size={12} className={rawChunks ? 'rotate-90' : ''} />}
              {rawChunks ? 'Hide raw chunks' : 'Show raw chunks'}
            </button>
            {rawChunks && (
              <div className="mt-2">
                {rawChunks.length === 0 ? (
                  <div className="px-2 text-[11px] text-slate-600">no streamed chunks (non-streaming call)</div>
                ) : (
                  <CopyBlock text={rawChunks.join('')} sub={`${rawChunks.length} deltas`} />
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="uppercase tracking-wider opacity-60">{k}</span>
      <span className="font-mono text-slate-400">{v}</span>
    </span>
  );
}

function JsonPanel({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <CopyBlock text={JSON.stringify(value, null, 2)} />
    </div>
  );
}

function CopyBlock({ text, sub }: { text: string; sub?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="group relative rounded-lg border border-white/[0.06] bg-black/30">
      <button
        onClick={copy}
        className="absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-1 text-[10px] text-slate-400 opacity-0 transition hover:bg-white/[0.12] hover:text-slate-200 group-hover:opacity-100"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {sub}
      </button>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs text-slate-300">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source tag
// ---------------------------------------------------------------------------

const SOURCE_STYLE: Record<string, string> = {
  'chat-turn': 'border-accent/25 bg-accent/10 text-accent',
  'title-gen': 'border-white/[0.08] bg-white/[0.04] text-slate-400',
  identity: 'border-reasoning/25 bg-reasoning/10 text-reasoning',
  vision: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-400',
  judge: 'border-amber-400/25 bg-amber-400/10 text-amber-400',
};

function TagChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

function SourceTag({ source }: { source: string }) {
  return (
    <span
      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
        SOURCE_STYLE[source] ?? 'border-white/[0.08] bg-white/[0.04] text-slate-400'
      }`}
    >
      {source}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
