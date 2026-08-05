import { useEffect, useState } from 'react';
import { Bot, CalendarClock, Cloud, Hand, RefreshCw } from 'lucide-react';
import { Button, EmptyState } from '../../components/ui';
import { flowsApi, type FlowRunSummary } from '../../lib/api';

const TRIGGER_ICON = {
  manual: Hand,
  agent: Bot,
  cron: CalendarClock,
  api: Cloud,
} as const;

const STATUS_TONE: Record<string, string> = {
  success: 'text-emerald-400',
  error: 'text-red-400',
  aborted: 'text-red-400',
  running: 'text-accent',
  awaiting_input: 'text-amber-400',
};

/**
 * Run history for one flow. Selecting a run replays it onto the canvas — the same node cards, with
 * the persisted per-node states — so a failure from last night is inspected exactly where it
 * happened rather than in a log pane somewhere else.
 */
export function FlowRunsPanel({
  flowId,
  selectedRunId,
  onSelect,
  reloadKey,
}: {
  flowId: string;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  reloadKey: number;
}) {
  const [runs, setRuns] = useState<FlowRunSummary[] | null>(null);

  useEffect(() => {
    let alive = true;
    flowsApi
      .runs(flowId)
      .then((r) => alive && setRuns(r))
      .catch(() => alive && setRuns([]));
    return () => {
      alive = false;
    };
  }, [flowId, reloadKey]);

  const reload = () => flowsApi.runs(flowId).then(setRuns).catch(() => undefined);

  if (!runs) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Runs</span>
        <Button variant="ghost" icon={<RefreshCw size={12} />} onClick={reload} className="ml-auto !px-2 !py-1">
          {''}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {runs.length === 0 ? (
          <EmptyState>No runs yet.</EmptyState>
        ) : (
          runs.map((run) => {
            const Icon = TRIGGER_ICON[run.trigger] ?? Hand;
            const active = run.id === selectedRunId;
            return (
              <button
                key={run.id}
                onClick={() => onSelect(run.id)}
                className={`mb-1 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                  active ? 'bg-accent/15 shadow-[inset_2px_0_0_0_rgba(59,130,246,0.7)]' : 'hover:bg-white/[0.05]'
                }`}
              >
                <Icon size={12} className="shrink-0 text-slate-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] text-slate-300">
                    {new Date(run.startedAt).toLocaleString()}
                  </div>
                  {run.error && <div className="truncate text-[10px] text-red-400/80">{run.error}</div>}
                </div>
                <span className={`shrink-0 text-[10px] ${STATUS_TONE[run.status] ?? 'text-slate-500'}`}>
                  {duration(run)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function duration(run: FlowRunSummary): string {
  if (!run.endedAt) return run.status === 'running' ? '…' : run.status;
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
