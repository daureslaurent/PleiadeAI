import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, MessageSquareDiff, Plus, Sparkles, SquareCheckBig } from 'lucide-react';
import { boardApi, type BoardPlan } from '../../lib/api';
import { Button, Callout, Chip, EmptyState, Row, Section, Spinner } from '../../components/ui';
import { PlanStateBadge, ProgressTrack, TaskStateBadge, TurnMeter } from './boardBits';
import { CreateItemPanel } from './CreateItemPanel';

/**
 * The board's front page: every task and project, and what each one is waiting on.
 *
 * One list rather than a section per kind (`BOARD_REFACTOR_PLAN.md`): the question an operator
 * brings here is "is anything stuck?", and a task that needs a verdict is as urgent as a project
 * that needs one. The filter narrows by kind when that is the question instead.
 */

type Filter = 'all' | 'project' | 'task' | 'attention';

const FILTERS: { id: Filter; label: string; match: (p: BoardPlan) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'project', label: 'Projects', match: (p) => p.kind !== 'task' },
  { id: 'task', label: 'Tasks', match: (p) => p.kind === 'task' },
  { id: 'attention', label: 'Needs you', match: (p) => Boolean(p.needsYou) },
];

export function BoardView() {
  const nav = useNavigate();
  const [plans, setPlans] = useState<BoardPlan[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    boardApi
      .plans()
      .then(setPlans)
      .catch((err) => setError(String(err?.response?.data?.error ?? err)));
  }, []);

  useEffect(() => {
    load();
    // A dispatched turn takes minutes and changes a card's counts when it lands. Polling rather than
    // a socket room because the board page is not the hot path the chat stream is, and one request
    // every fifteen seconds is cheaper than a second event vocabulary to maintain.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(() => {
    const match = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
    return (plans ?? []).filter(match);
  }, [plans, filter]);

  if (!plans) return error ? <Callout tone="error">{error}</Callout> : <Spinner />;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        <Section
          title="Board"
          icon={<ListChecks size={13} />}
          right={
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating((v) => !v)}>
              New
            </Button>
          }
        >
          <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
            A task is one piece of work with an owner and a reviewer; a project is a goal its manager
            breaks into tasks. The board dispatches each task once everything it waits on is accepted,
            and every item has a chat with its manager.
          </p>
          {error ? <Callout tone="error">{error}</Callout> : null}

          {creating ? (
            <div className="mb-4">
              <CreateItemPanel onCancel={() => setCreating(false)} />
            </div>
          ) : null}

          {plans.length ? (
            <div className="mb-3 flex flex-wrap items-center gap-1 rounded-lg raise-1 p-0.5 sm:w-fit">
              {FILTERS.map((f) => {
                const n = plans.filter(f.match).length;
                const active = filter === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                      active ? 'raise-3 text-slate-100' : 'text-slate-500 hover:text-slate-300'
                    }`}
                  >
                    {f.label}
                    <span
                      className={`ml-1 tabular-nums ${f.id === 'attention' && n ? 'text-amber-400' : 'text-slate-500'}`}
                    >
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {!plans.length && !creating ? (
            <EmptyState icon={<ListChecks size={20} />}>
              Nothing on the board yet. Press <strong>New</strong>, describe what you want, and let an
              agent fill in the rest.
            </EmptyState>
          ) : null}

          {plans.length && !shown.length ? (
            <EmptyState>
              {filter === 'attention' ? 'Nothing is waiting on you.' : 'Nothing in this view.'}
            </EmptyState>
          ) : null}

          <div className="space-y-2">
            {shown.map((plan) => (
              <ItemCard key={plan.id} plan={plan} onOpen={() => nav(`/board/${plan.id}`)} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function ItemCard({ plan, onOpen }: { plan: BoardPlan; onOpen: () => void }) {
  const isTask = plan.kind === 'task';
  const total = plan.taskCount ?? 0;
  const done = plan.doneCount ?? 0;
  const blocked = plan.blockedCount ?? 0;
  const review = plan.reviewCount ?? 0;
  const doing = plan.doingCount ?? 0;

  return (
    <Row className={`p-3 ${plan.needsYou ? 'border-amber-500/30' : ''}`} onClick={onOpen}>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <Chip className="mt-0.5">
            {isTask ? <SquareCheckBig size={10} /> : <ListChecks size={10} />}
            {isTask ? 'task' : 'project'}
          </Chip>
          <span className="min-w-0 flex-1">
            <span className="block text-sm leading-snug text-slate-100">{plan.name || plan.goal}</span>
            {plan.description ? (
              <span className="mt-0.5 line-clamp-2 block text-[11px] leading-relaxed text-slate-500">
                {plan.description}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1">
            <PlanStateBadge state={plan.state} />
            {isTask && plan.task ? <TaskStateBadge state={plan.task.state} live={plan.task.inFlight} /> : null}
          </span>
        </div>

        {isTask ? (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
            <span className={plan.task?.owner ? 'text-slate-400' : 'text-amber-400'}>
              {plan.task?.owner?.display_name ?? 'unowned'}
            </span>
            <span className="text-slate-600">→</span>
            <span>{plan.task?.reviewer?.display_name ?? plan.manager.display_name}</span>
          </div>
        ) : total ? (
          <div className="space-y-1.5">
            <ProgressTrack
              counts={{ done, blocked, review, doing, todo: Math.max(0, total - done - blocked - review - doing), cancelled: 0 }}
              total={total}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span className="text-slate-400">
                {done}/{total} accepted
              </span>
              {blocked ? <span className="text-red-400">{blocked} blocked</span> : null}
              {review ? <span className="text-accent">{review} in review</span> : null}
              <span className="ml-auto">
                <TurnMeter spent={plan.turnsSpent} max={plan.turnsMax} />
              </span>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-amber-400">no tasks yet — its manager is planning it, or open it to ask</div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
          <span>managed by {plan.manager.display_name}</span>
          {plan.revision > 0 ? <span>revision {plan.revision}</span> : null}
          {plan.pendingProposal ? (
            <span className="inline-flex items-center gap-1 text-accent">
              <MessageSquareDiff size={11} /> changes proposed
            </span>
          ) : null}
        </div>

        {/* The reason the scheduler gave up, verbatim. Without it, "needs you" is a colour. */}
        {plan.escalation ? (
          <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-2 py-1.5 text-[11px] leading-relaxed text-amber-300">
            <Sparkles size={11} className="mt-0.5 shrink-0" />
            <span className="line-clamp-2 min-w-0">{plan.escalation}</span>
          </div>
        ) : null}
      </div>
    </Row>
  );
}
