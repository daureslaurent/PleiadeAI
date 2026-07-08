import { Database, Loader2, AlertTriangle } from 'lucide-react';
import type { DatasetStats, ScoreTag } from '../../lib/api';

/**
 * Training-data composition: how many examples exist, and the quality distribution of the judged
 * subset. The segmented bar is the "chart" — a hand-rolled CSS stack in DIRECT_ART grammar, with
 * semantic colors (Perfect → emerald, Patched → accent, Recovered → amber, Rejected → red).
 *
 * The min-score / tag filter here is the same one that selects the training set on launch, so the
 * `filtered_count` doubles as a live "how many examples will train" preview.
 */
export const TAGS: ScoreTag[] = ['Perfect', 'Patched', 'Recovered', 'Rejected'];

const TAG_COLOR: Record<ScoreTag, { bar: string; text: string; dot: string }> = {
  Perfect: { bar: 'bg-emerald-400/70', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  Patched: { bar: 'bg-accent/70', text: 'text-accent', dot: 'bg-accent' },
  Recovered: { bar: 'bg-amber-400/70', text: 'text-amber-300', dot: 'bg-amber-400' },
  Rejected: { bar: 'bg-red-400/70', text: 'text-red-300', dot: 'bg-red-400' },
};

export function DatasetPanel({
  stats,
  error,
  minScore,
  tags,
  onMinScore,
  onToggleTag,
}: {
  stats: DatasetStats | null;
  error: boolean;
  minScore: number;
  tags: ScoreTag[];
  onMinScore: (v: number) => void;
  onToggleTag: (tag: ScoreTag) => void;
}) {
  if (error) {
    return (
      <section className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-5">
        <div className="flex items-center gap-2 text-sm text-red-300">
          <AlertTriangle size={15} /> Failed to load dataset statistics.
        </div>
      </section>
    );
  }

  if (!stats) {
    return (
      <section className="glass-card animate-fade-up flex items-center gap-2 rounded-2xl border border-white/[0.06] p-5 text-sm text-slate-500">
        <Loader2 size={14} className="animate-spin" /> Loading dataset…
      </section>
    );
  }

  const scoredTotal = stats.scored.total;
  const unscored = Math.max(0, stats.total_examples - scoredTotal);

  return (
    <section className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-5">
      <header className="mb-4 flex items-center gap-3">
        <Database size={16} className="text-accent" />
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Training data</h2>
          <p className="text-xs text-slate-500">
            Exportable agent-runs and the quality distribution of the judged subset.
          </p>
        </div>
      </header>

      <div className="grid gap-5 md:grid-cols-[auto,1fr]">
        {/* Headline counts */}
        <div className="flex gap-6 md:flex-col md:gap-3">
          <Stat label="Examples" value={stats.total_examples.toLocaleString()} />
          <Stat label="Scored" value={scoredTotal.toLocaleString()} />
          <Stat label="Avg score" value={scoredTotal ? String(stats.scored.avgScore) : '—'} />
        </div>

        {/* Quality distribution */}
        <div>
          {scoredTotal === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-black/20 px-4 py-6 text-center text-xs text-slate-500">
              No runs scored yet — score some conversations to see the quality distribution.
            </div>
          ) : (
            <>
              <div className="flex h-3 overflow-hidden rounded-full border border-white/[0.06] bg-black/30">
                {TAGS.map((tag) => {
                  const n = stats.scored.byTag[tag] ?? 0;
                  if (!n) return null;
                  return (
                    <div
                      key={tag}
                      className={`${TAG_COLOR[tag].bar} transition-all`}
                      style={{ width: `${(n / scoredTotal) * 100}%` }}
                      title={`${tag}: ${n}`}
                    />
                  );
                })}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {TAGS.map((tag) => {
                  const n = stats.scored.byTag[tag] ?? 0;
                  return (
                    <span key={tag} className="inline-flex items-center gap-1.5 text-[11px]">
                      <span className={`h-1.5 w-1.5 rounded-full ${TAG_COLOR[tag].dot}`} />
                      <span className="text-slate-400">{tag}</span>
                      <span className="font-mono text-slate-200">{n}</span>
                    </span>
                  );
                })}
                {unscored > 0 && (
                  <span className="inline-flex items-center gap-1.5 text-[11px]">
                    <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
                    <span className="text-slate-500">Unscored</span>
                    <span className="font-mono text-slate-400">{unscored}</span>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filter = the training-set selector */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-white/[0.06] pt-4">
        <label className="flex items-center gap-2.5">
          <span className="text-[10px] uppercase tracking-wider text-slate-500">Min score</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={minScore}
            onChange={(e) => onMinScore(Number(e.target.value))}
            className="h-1 w-32 cursor-pointer appearance-none rounded-full bg-white/[0.1] accent-accent"
          />
          <span className="w-8 font-mono text-xs text-slate-200">{minScore}</span>
        </label>

        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-slate-500">Tags</span>
          {TAGS.map((tag) => {
            const on = tags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => onToggleTag(tag)}
                className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                  on
                    ? `border-white/[0.12] bg-white/[0.06] ${TAG_COLOR[tag].text}`
                    : 'border-white/[0.06] text-slate-500 hover:bg-white/[0.05]'
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>

        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/10 px-2.5 py-1 text-[11px] text-accent">
          <span className="uppercase tracking-wider opacity-70">Will train on</span>
          <span className="font-mono text-slate-100">{stats.filtered_count.toLocaleString()}</span>
        </span>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-2xl text-slate-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}
