import type { ScoreTag } from '../lib/api';

/**
 * Compact Conversation Quality Scorer badge — a score number + tag, colored by band. Shared by the
 * chat turn header (tiny), the LLM Debug records, and the Scoring page. Semantic colors per
 * DIRECT_ART: emerald = good (Perfect), amber = usable (Patched/Recovered), red = bad (Rejected).
 */

export interface ScoreLike {
  score: number;
  tag: ScoreTag;
  explanation?: string;
}

const TAG_STYLE: Record<ScoreTag, string> = {
  Perfect: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  Patched: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  Recovered: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  Rejected: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const DOT: Record<ScoreTag, string> = {
  Perfect: 'bg-emerald-400',
  Patched: 'bg-amber-400',
  Recovered: 'bg-amber-400',
  Rejected: 'bg-red-400',
};

export function ScoreBadge({
  score,
  size = 'sm',
  showTag = true,
}: {
  score: ScoreLike;
  /** `xs` = the tiny chat-header pill (number + dot); `sm` = number + tag chip. */
  size?: 'xs' | 'sm';
  showTag?: boolean;
}) {
  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${pad} ${TAG_STYLE[score.tag]}`}
      title={score.explanation ? `${score.tag} · ${score.score}/100 — ${score.explanation}` : `${score.tag} · ${score.score}/100`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[score.tag]}`} />
      <span className="font-mono tabular-nums">{score.score}</span>
      {showTag && size === 'sm' && <span className="opacity-80">{score.tag}</span>}
    </span>
  );
}
