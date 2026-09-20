import { useEffect, useRef, useState } from 'react';
import { migrationApi, type MigrationJob } from '../../../lib/api';

/** Bytes as a human size. Migration numbers span four orders of magnitude, so a fixed unit won't do. */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/**
 * Poll the single in-flight migration job.
 *
 * Polling rather than a socket subscription, deliberately: a restore's first act is to drop every
 * websocket (the backend cannot let a live chat turn write into a collection it is replacing), so a
 * socket-borne progress feed would go silent exactly when the operator most needs to see it.
 */
export function useMigrationJob(initial: MigrationJob | null, onSettled?: (job: MigrationJob) => void) {
  const [job, setJob] = useState<MigrationJob | null>(initial);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!job || job.status !== 'running') return;
    settledRef.current = false;
    const timer = setInterval(() => {
      migrationApi
        .job()
        .then((next) => {
          if (!next) return;
          setJob(next);
          if (next.status !== 'running' && !settledRef.current) {
            settledRef.current = true;
            onSettled?.(next);
          }
        })
        // A restore ends by restarting the backend, so a failed poll is the expected ending, not an error.
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [job, onSettled]);

  return [job, setJob] as const;
}

/** Live progress for the running job: phase, a bar where a total is known, and any warnings so far. */
export function JobProgress({ job }: { job: MigrationJob }) {
  const pct = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
  const tone =
    job.status === 'error' ? 'text-red-400' : job.status === 'done' ? 'text-emerald-400' : 'text-slate-300';

  return (
    <div className="space-y-2 rounded-xl border hairline well p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-xs ${tone}`}>{job.error ?? job.phase}</span>
        {job.total > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-slate-500">
            {formatCount(job.done)} / {formatCount(job.total)}
          </span>
        )}
      </div>

      {/* An indeterminate phase (checksumming, index replay) gets a pulsing bar rather than a fake
          percentage — a progress bar that lies is worse than one that admits it doesn't know. */}
      <div className="h-1 overflow-hidden rounded-full raise-2">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            job.status === 'error' ? 'bg-red-500/70' : 'bg-accent'
          } ${pct === null && job.status === 'running' ? 'w-1/3 animate-pulse' : ''}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>

      {job.warnings.length > 0 && (
        <ul className="max-h-32 space-y-0.5 overflow-auto text-[10px] leading-relaxed text-amber-400/80">
          {job.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A census rendered as a scannable table — the same shape on both sides of a move. */
export function CensusTable({
  collections,
  qdrant,
  emptyLabel = 'Nothing stored.',
}: {
  collections: Record<string, number>;
  qdrant: Record<string, number>;
  emptyLabel?: string;
}) {
  const rows = Object.entries(collections).filter(([, n]) => n > 0);
  const qrows = Object.entries(qdrant).filter(([, n]) => n > 0);
  if (rows.length === 0 && qrows.length === 0) {
    return <p className="px-2 py-3 text-[11px] text-slate-500">{emptyLabel}</p>;
  }
  return (
    <div className="max-h-56 overflow-auto rounded-xl border hairline well">
      <table className="w-full text-[11px]">
        <tbody>
          {rows.map(([name, n]) => (
            <tr key={name} className="border-b hairline last:border-0">
              <td className="px-2.5 py-1 font-mono text-slate-400">{name}</td>
              <td className="px-2.5 py-1 text-right tabular-nums text-slate-300">{formatCount(n)}</td>
            </tr>
          ))}
          {qrows.map(([name, n]) => (
            <tr key={`q-${name}`} className="border-b hairline last:border-0">
              <td className="px-2.5 py-1 font-mono text-slate-400">
                <span className="mr-1.5 text-[9px] uppercase tracking-wider text-accent">vec</span>
                {name}
              </td>
              <td className="px-2.5 py-1 text-right tabular-nums text-slate-300">{formatCount(n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
