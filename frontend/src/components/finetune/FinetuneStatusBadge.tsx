import type { FinetuneJobStatus } from '../../lib/api';

/**
 * Status pill for a fine-tune job. Follows `ScoreBadge`'s grammar: rounded-full, a state dot, and
 * semantic color only (emerald = success, amber = in-flight, red = error, slate = idle).
 * Live phases breathe (`animate-glow-pulse`); terminal ones are still — motion marks liveness.
 */
const STYLE: Record<FinetuneJobStatus, { pill: string; dot: string; live: boolean }> = {
  queued: { pill: 'border-white/[0.1] bg-white/[0.04] text-slate-400', dot: 'bg-slate-500', live: false },
  preparing: { pill: 'border-amber-500/25 bg-amber-500/10 text-amber-300', dot: 'bg-amber-400', live: true },
  training: { pill: 'border-accent/25 bg-accent/10 text-accent', dot: 'bg-accent', live: true },
  exporting: { pill: 'border-amber-500/25 bg-amber-500/10 text-amber-300', dot: 'bg-amber-400', live: true },
  done: { pill: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300', dot: 'bg-emerald-400', live: false },
  failed: { pill: 'border-red-500/25 bg-red-500/10 text-red-300', dot: 'bg-red-400', live: false },
};

export function FinetuneStatusBadge({ status }: { status: FinetuneJobStatus }) {
  const s = STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${s.pill}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${s.dot} ${s.live ? 'animate-glow-pulse' : ''}`}
        style={s.live ? ({ ['--glow' as string]: 'currentColor' } as React.CSSProperties) : undefined}
      />
      {status}
    </span>
  );
}
