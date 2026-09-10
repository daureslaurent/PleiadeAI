import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, PauseCircle, ScanEye } from 'lucide-react';
import { StatusBadge, type Tone } from '../../components/ui';
import type { BoardPlanState, BoardTaskState } from '../../lib/api';

/**
 * The task states, in the app's single status vocabulary (`DIRECT_ART.md` §2 — semantic colour,
 * never decorative).
 *
 * `review` gets its own icon rather than sharing `doing`'s because it is the state the whole design
 * turns on: work that exists and is waiting on somebody *else*. An operator scanning a project needs
 * to tell "still being written" from "written, nobody has looked at it" at a glance, since only the
 * second one is a queue they can clear themselves.
 */
export const TASK_STATES: Record<BoardTaskState, { label: string; tone: Tone; Icon: typeof CircleDashed }> = {
  todo: { label: 'todo', tone: 'idle', Icon: CircleDashed },
  doing: { label: 'doing', tone: 'busy', Icon: Loader2 },
  review: { label: 'in review', tone: 'accent', Icon: ScanEye },
  blocked: { label: 'blocked', tone: 'error', Icon: AlertTriangle },
  done: { label: 'done', tone: 'ok', Icon: CheckCircle2 },
  cancelled: { label: 'cancelled', tone: 'idle', Icon: PauseCircle },
};

export const PLAN_STATES: Record<BoardPlanState, { label: string; tone: Tone }> = {
  draft: { label: 'draft', tone: 'idle' },
  running: { label: 'running', tone: 'busy' },
  blocked: { label: 'needs you', tone: 'error' },
  done: { label: 'done', tone: 'ok' },
  cancelled: { label: 'cancelled', tone: 'idle' },
};

export function TaskStateBadge({ state, live }: { state: BoardTaskState; live?: boolean }) {
  const { label, tone, Icon } = TASK_STATES[state];
  return (
    <StatusBadge tone={tone}>
      {/* Spin only while a turn is genuinely running — never animate something idle. */}
      <Icon size={11} className={live ? 'animate-spin' : ''} />
      {label}
    </StatusBadge>
  );
}

export function PlanStateBadge({ state }: { state: BoardPlanState }) {
  const { label, tone } = PLAN_STATES[state];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

/**
 * The turn allowance as a bar.
 *
 * A project's leash is the number an operator raises, and a number in a corner is one nobody reads
 * until it has already run out — which is exactly how the old per-thread budget stranded threads
 * silently. Turning amber at 80% is the whole point of drawing it.
 */
export function TurnMeter({ spent, max }: { spent: number; max: number }) {
  const pct = Math.min(100, Math.round((spent / Math.max(1, max)) * 100));
  const tone = pct >= 100 ? 'bg-red-400' : pct >= 80 ? 'bg-amber-400' : 'bg-accent';
  return (
    <span className="inline-flex items-center gap-2" title={`${spent} of ${max} agent turns spent`}>
      <span className="h-1 w-16 overflow-hidden rounded-full raise-2">
        <span className={`block h-full ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[10px] tabular-nums text-slate-500">
        {spent}/{max}
      </span>
    </span>
  );
}

/** A deliverable reference, rendered as what it is rather than as a bare id. */
export function DeliverableChip({ kind, refValue, note }: { kind: string; refValue: string; note?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md raise-2 px-2 py-1 text-[11px] text-slate-300">
      <span className="uppercase tracking-wider text-slate-500">{kind}</span>
      <code className="truncate font-mono text-[10px] text-slate-200">{refValue}</code>
      {note ? <span className="truncate text-slate-400">— {note}</span> : null}
    </span>
  );
}

/** A labelled block in a task card. Keeps the three-column card from needing its own grid rules. */
export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="min-w-0 text-xs text-slate-300">{children}</div>
    </div>
  );
}

/**
 * The state ordering used everywhere the board sorts or groups tasks: what the operator has to act
 * on first, then what is moving, then what is finished. A project page that lists tasks in creation
 * order buries the one thing that has stopped under three that are fine.
 */
export const TASK_ORDER: Record<BoardTaskState, number> = {
  blocked: 0,
  review: 1,
  doing: 2,
  todo: 3,
  done: 4,
  cancelled: 5,
};

/** The bar segments, in reading order — done first so progress grows from the left. */
const TRACK: { state: BoardTaskState; className: string }[] = [
  { state: 'done', className: 'bg-emerald-400' },
  { state: 'review', className: 'bg-accent' },
  { state: 'doing', className: 'bg-amber-400' },
  { state: 'blocked', className: 'bg-red-400' },
];

/**
 * A project's tasks as one segmented bar.
 *
 * The counts were previously four numbers in a metadata line, which is a thing you read only after
 * deciding to. The bar answers "is this moving, and is anything stuck?" pre-attentively — a red
 * notch is visible without reading a word — and the counts stay underneath for the exact answer.
 */
export function ProgressTrack({ counts, total }: { counts: Record<BoardTaskState, number>; total: number }) {
  const denom = Math.max(1, total);
  return (
    <span className="flex h-1.5 w-full overflow-hidden rounded-full raise-2">
      {TRACK.map(({ state, className }) =>
        counts[state] ? (
          <span
            key={state}
            className={className}
            style={{ width: `${(counts[state] / denom) * 100}%` }}
            title={`${counts[state]} ${TASK_STATES[state].label}`}
          />
        ) : null,
      )}
    </span>
  );
}

/** Tally a task list by state — the shape `ProgressTrack` and the filter tabs both read. */
export function tallyStates(states: BoardTaskState[]): Record<BoardTaskState, number> {
  const counts = { todo: 0, doing: 0, review: 0, blocked: 0, done: 0, cancelled: 0 };
  for (const s of states) counts[s] += 1;
  return counts;
}

/**
 * A task the board cannot move on its own: nobody but the operator can review it, or it has stopped
 * with a reason. This is the definition the "needs you" filter and the auto-expanded cards share, so
 * the count on the tab and the cards that open themselves can never disagree.
 */
export function needsOperator(task: { state: BoardTaskState; reviewer: unknown | null }): boolean {
  return task.state === 'blocked' || (task.state === 'review' && !task.reviewer);
}
