import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, OctagonX, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { agentsApi, autonomyApi, type Agent, type AutonomyJob } from '../../lib/api';
import { agentColor, registerAgentIdentities } from '../../lib/agentColor';
import { Button, Chip, EmptyState, Section, useConfirm } from '../../components/ui';
import { ScheduleForm } from './ScheduleForm';
import { RunHistoryPanel } from './RunHistoryPanel';
import { InboxPanel } from './InboxPanel';
import { TelegramPanel } from './TelegramPanel';
import { fmtDateTime, relativeTime } from './time';

/**
 * Autonomy command board (spec §5), one screen for everything headless:
 * schedules (full CRUD + kill switch) · the selected schedule's run history · the notifications
 * inbox · the Telegram alert channel. Master-detail + rail layout, glass over the starfield.
 */
export function AutonomyView() {
  const confirm = useConfirm();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [jobs, setJobs] = useState<AutonomyJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** `undefined` = closed; `null` = create; a job = edit. */
  const [form, setForm] = useState<AutonomyJob | null | undefined>(undefined);

  useEffect(() => {
    agentsApi
      .list()
      .then((all) => {
        registerAgentIdentities(all);
        setAgents(all.filter((a) => !a.subagent));
      })
      .catch(() => undefined);
  }, []);

  const refreshJobs = useCallback(() => {
    autonomyApi.jobs().then(setJobs).catch(() => undefined);
  }, []);

  // Liveness poll: tight while something is executing, relaxed otherwise (DIRECT_ART §6 — the
  // running glow must extinguish itself when the run settles).
  const anyRunning = jobs.some((j) => j.running);
  useEffect(() => {
    refreshJobs();
    const t = setInterval(refreshJobs, anyRunning ? 5_000 : 15_000);
    return () => clearInterval(t);
  }, [refreshJobs, anyRunning]);

  const selected = useMemo(
    () => jobs.find((j) => j.id === selectedId) ?? null,
    [jobs, selectedId],
  );

  async function runNow(id: string) {
    await autonomyApi.run(id);
    setTimeout(refreshJobs, 1000);
  }

  async function removeJob(job: AutonomyJob) {
    const ok = await confirm({
      title: 'Delete schedule?',
      body: `“${job.data.agentName}” — ${job.data.prompt.slice(0, 140)}\n\nIts run history stays readable until the page reloads; the schedule itself is gone for good.`,
      danger: true,
    });
    if (!ok) return;
    await autonomyApi.remove(job.id);
    if (selectedId === job.id) setSelectedId(null);
    refreshJobs();
  }

  async function killAll() {
    const ok = await confirm({
      title: 'Kill all autonomous tasks?',
      body: `Every scheduled task (${jobs.length}) will be cancelled. Run histories and notifications are kept.`,
      danger: true,
      confirmLabel: 'Kill all',
    });
    if (!ok) return;
    await autonomyApi.kill();
    setSelectedId(null);
    refreshJobs();
  }

  return (
    <div className="flex h-full gap-4 overflow-hidden p-4">
      {/* Schedules (master) */}
      <Section
        title={`Schedules · ${jobs.length}`}
        icon={<CalendarClock size={13} />}
        className="flex w-[22rem] min-h-0 shrink-0 flex-col"
        right={
          <>
            <Button variant="accentSoft" icon={<Plus size={12} />} onClick={() => setForm(null)}>
              New
            </Button>
            <button
              onClick={killAll}
              disabled={!jobs.length}
              title="Kill switch — cancel every scheduled task"
              className="rounded-md p-1 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:pointer-events-none disabled:opacity-40"
            >
              <OctagonX size={14} />
            </button>
          </>
        }
      >
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          {jobs.map((job) => (
            <ScheduleCard
              key={job.id}
              job={job}
              active={job.id === selectedId}
              onSelect={() => setSelectedId(job.id)}
              onRun={() => void runNow(job.id)}
              onEdit={() => setForm(job)}
              onDelete={() => void removeJob(job)}
            />
          ))}
          {!jobs.length && (
            <EmptyState icon={<CalendarClock size={24} />}>
              No schedules yet. Create one, or let an agent schedule its own via the
              schedule_task tool.
            </EmptyState>
          )}
        </div>
      </Section>

      {/* Run history (detail) */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RunHistoryPanel job={selected} onRunNow={runNow} />
      </div>

      {/* Rail: inbox + telegram */}
      <div className="flex w-80 min-h-0 shrink-0 flex-col gap-4">
        <InboxPanel agents={agents} />
        <TelegramPanel />
      </div>

      {form !== undefined && (
        <ScheduleForm
          agents={agents}
          initial={form}
          onClose={() => setForm(undefined)}
          onSaved={refreshJobs}
        />
      )}
    </div>
  );
}

/** One schedule in the master list: identity-colored, glowing while its run executes. */
function ScheduleCard({
  job,
  active,
  onSelect,
  onRun,
  onEdit,
  onDelete,
}: {
  job: AutonomyJob;
  active: boolean;
  onSelect: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const color = agentColor(job.data.agentName);
  const spent = job.once && !job.nextRunAt && !job.running;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect()}
      style={job.running ? ({ '--glow': `${color.accent}` } as React.CSSProperties) : undefined}
      className={`group cursor-pointer rounded-xl border p-3 text-xs backdrop-blur-sm transition-colors ${
        active
          ? 'border-accent/50 bg-accent/10'
          : 'border-white/[0.06] bg-white/[0.03] hover:border-white/[0.12]'
      } ${job.running ? 'animate-glow-pulse' : ''} ${spent ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color.accent }} />
        <span className="truncate font-semibold tracking-wide" style={{ color: color.accent }}>
          {job.data.agentName}
        </span>
        {job.running ? (
          <span className="text-shimmer shrink-0 text-[10px] text-amber-400">running…</span>
        ) : (
          <Chip className="font-mono normal-case">{job.once ? 'once' : job.cron}</Chip>
        )}
        {/* Hover actions — quiet icons, red reserved for delete. */}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRun();
            }}
            title="Run now"
            className="rounded p-1 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-accent"
          >
            <Play size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            title="Edit"
            className="rounded p-1 text-slate-400 transition-colors hover:bg-white/[0.08] hover:text-slate-100"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete"
            className="rounded p-1 text-slate-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 leading-relaxed text-slate-500">{job.data.prompt}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-600">
        {spent ? (
          <span>completed</span>
        ) : (
          <span title={fmtDateTime(job.nextRunAt)}>next {relativeTime(job.nextRunAt)}</span>
        )}
        <span title={fmtDateTime(job.lastRunAt)}>last {relativeTime(job.lastRunAt)}</span>
        {job.data.alert === false && <span className="uppercase">silent</span>}
        {job.data.ownerAgent && <span className="uppercase">agent-owned</span>}
      </div>
    </div>
  );
}
