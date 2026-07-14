import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, History, Play, RefreshCw } from 'lucide-react';
import { autonomyApi, type AutonomyJob, type AutonomyRunResult } from '../../lib/api';
import { agentColor, agentInitial } from '../../lib/agentColor';
import { Markdown } from '../../components/Markdown';
import { Button, Chip, EmptyState, Section, Spinner, StatusBadge } from '../../components/ui';
import { duration, fmtDateTime, relativeTime } from './time';

/**
 * Center pane of the Autonomy board: every recorded run of the selected schedule, newest first
 * (full markdown output). Re-fetches on its own while the schedule is executing so a fired run
 * lands in the history without a manual refresh.
 */
export function RunHistoryPanel({
  job,
  onRunNow,
}: {
  job: AutonomyJob | null;
  /** Fire the schedule immediately (parent owns the jobs list refresh). */
  onRunNow: (id: string) => Promise<void>;
}) {
  const [results, setResults] = useState<AutonomyRunResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [firing, setFiring] = useState(false);
  const jobId = job?.id ?? null;
  // Ignore stale fetches after switching schedules mid-flight.
  const activeId = useRef<string | null>(null);

  const load = useCallback((id: string, spinner: boolean) => {
    if (spinner) setLoading(true);
    autonomyApi
      .results(id)
      .then((r) => activeId.current === id && setResults(r))
      .finally(() => activeId.current === id && setLoading(false));
  }, []);

  useEffect(() => {
    activeId.current = jobId;
    setResults([]);
    if (jobId) load(jobId, true);
  }, [jobId, load]);

  // While the schedule is executing (or just fired), poll so the finishing run appears live.
  const running = Boolean(job?.running) || firing;
  useEffect(() => {
    if (!jobId || !running) return;
    const t = setInterval(() => load(jobId, false), 4000);
    return () => clearInterval(t);
  }, [jobId, running, load]);

  if (!job) {
    return (
      <Section title="Run history" icon={<History size={13} />} className="flex min-h-0 flex-col">
        <EmptyState icon={<CalendarClock size={28} />}>
          Select a schedule to inspect its runs.
        </EmptyState>
      </Section>
    );
  }

  const color = agentColor(job.data.agentName);

  async function fireNow() {
    setFiring(true);
    try {
      await onRunNow(job!.id);
      // Keep polling a little while even if the running flag hasn't propagated yet.
      setTimeout(() => setFiring(false), 20_000);
    } catch {
      setFiring(false);
    }
  }

  return (
    <Section
      title={`Run history · ${results.length || '—'}`}
      icon={<History size={13} />}
      className="flex min-h-0 flex-col"
      right={
        <>
          <Button
            variant="ghost"
            icon={<RefreshCw size={12} />}
            onClick={() => load(job.id, true)}
            title="Refresh"
          >
            Refresh
          </Button>
          <Button variant="accentSoft" icon={<Play size={12} />} loading={firing} onClick={fireNow}>
            Run now
          </Button>
        </>
      }
    >
      {/* Schedule identity header */}
      <div className="mb-3 flex items-center gap-2.5 border-b border-white/[0.06] pb-3">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white/90"
          style={{ backgroundColor: color.soft, boxShadow: `inset 0 0 0 1px ${color.border}` }}
        >
          <span style={{ color: color.accent }}>{agentInitial(job.data.agentName)}</span>
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold tracking-wide" style={{ color: color.accent }}>
              {job.data.agentName}
            </span>
            <Chip className="font-mono normal-case">{job.once ? 'once' : job.cron}</Chip>
            {job.running && (
              <span className="text-shimmer text-[11px] text-amber-400">running…</span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-slate-500" title={job.data.prompt}>
            {job.data.prompt}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {loading && <Spinner />}
        {!loading &&
          results.map((r) => (
            <article
              key={r.id}
              className="animate-fade-up rounded-xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-sm"
            >
              <header className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
                <StatusBadge tone={r.status === 'success' ? 'ok' : 'error'}>{r.status}</StatusBadge>
                <span className="text-[11px] text-slate-500" title={fmtDateTime(r.finishedAt)}>
                  {relativeTime(r.finishedAt)}
                </span>
                <Chip className="ml-auto font-mono normal-case">
                  {duration(r.startedAt, r.finishedAt)}
                </Chip>
              </header>
              {/* The prompt the run was fired with — relevant when the schedule was edited since. */}
              {r.prompt && r.prompt !== job.data.prompt && (
                <div className="border-b border-white/[0.06] px-3 py-1.5 text-[11px] text-slate-500">
                  <span className="uppercase tracking-wider text-slate-600">prompt </span>
                  {r.prompt}
                </div>
              )}
              <div className="px-3 py-2 text-sm">
                <Markdown>{r.output || '_(no output)_'}</Markdown>
              </div>
            </article>
          ))}
        {!loading && !results.length && (
          <EmptyState icon={<History size={24} />}>
            No runs recorded yet — fire one with “Run now”.
          </EmptyState>
        )}
      </div>
    </Section>
  );
}
