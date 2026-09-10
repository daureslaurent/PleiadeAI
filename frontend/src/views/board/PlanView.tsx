import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronDown,
  ListChecks,
  MessageSquareText,
  Play,
  Radio,
  Sparkles,
  Square,
  Wand2,
} from 'lucide-react';
import { boardApi, type BoardPlan, type BoardTask } from '../../lib/api';
import { Button, Callout, Chip, EmptyState, Section, Spinner, Textarea } from '../../components/ui';
import { useConfirm } from '../../components/ui';
import {
  DeliverableChip,
  Detail,
  needsOperator,
  PlanStateBadge,
  ProgressTrack,
  tallyStates,
  TASK_ORDER,
  TASK_STATES,
  TaskStateBadge,
  TurnMeter,
} from './boardBits';

/**
 * One project: its graph, and the two things only the operator can do to it.
 *
 * The page is built around reading the plan *before* it runs. The manager is an LLM and a bad plan
 * dispatches exactly as confidently as a good one, so a project stays `draft` until Start is pressed
 * here — and what is worth reading in a draft is precisely what this page leads with: each task's
 * acceptance criteria, its owner, its reviewer, and what it waits on.
 *
 * All of that at once, though, is a wall: five criteria × four tasks is a screen of prose in which
 * the one task that has stopped looks exactly like the four that are fine. So a task is a **card
 * that opens**. Closed, it carries only what triages it — state, goal, who owns it, how many
 * criteria there are; open, it is the full contract. Cards that need the operator open themselves,
 * which means the wall of text only ever appears where it is the answer to a question.
 */

type Filter = 'attention' | 'active' | 'done' | 'all';

const FILTERS: { id: Filter; label: string; match: (t: BoardTask) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'attention', label: 'Needs you', match: needsOperator },
  { id: 'active', label: 'Running', match: (t) => t.state === 'doing' || t.state === 'review' || t.state === 'todo' },
  { id: 'done', label: 'Accepted', match: (t) => t.state === 'done' },
];

export function PlanView() {
  const { planId = '' } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [plan, setPlan] = useState<(BoardPlan & { tasks: BoardTask[] }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Set once, on the first load that brings tasks: after that the operator's own opening and closing
  // owns the set, so a ten-second poll can't slam a card shut under the cursor.
  const [seeded, setSeeded] = useState(false);

  const load = useCallback(() => {
    boardApi
      .plan(planId)
      .then(setPlan)
      .catch((err) => setError(String(err?.response?.data?.error ?? err)));
  }, [planId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  // A task the board cannot move on its own is the reason the operator opened the page — so it is
  // already open when they get there, and everything else stays one line tall.
  useEffect(() => {
    if (seeded || !plan?.tasks.length) return;
    setOpen(new Set(plan.tasks.filter((t) => needsOperator(t) || t.inFlight).map((t) => t.id)));
    setSeeded(true);
  }, [plan, seeded]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
      load();
    } catch (err) {
      setError(String((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? err));
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo(() => tallyStates((plan?.tasks ?? []).map((t) => t.state)), [plan]);
  const shown = useMemo(() => {
    const match = FILTERS.find((f) => f.id === filter)?.match ?? (() => true);
    return (plan?.tasks ?? [])
      .filter(match)
      .slice()
      .sort((a, b) => TASK_ORDER[a.state] - TASK_ORDER[b.state]);
  }, [plan, filter]);

  if (!plan) return error ? <Callout tone="error">{error}</Callout> : <Spinner />;

  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const attention = plan.tasks.filter(needsOperator).length;
  const running = plan.state === 'running';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-3 p-4">
        <div className="flex items-center gap-3">
          <Button icon={<ArrowLeft size={13} />} onClick={() => nav('/board')}>
            Projects
          </Button>
          <Link
            to={`/forum/t/${plan.hubThreadId}`}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
          >
            <MessageSquareText size={11} />
            project thread
          </Link>
        </div>

        {/* ── The project header. One block, read top to bottom: what it is, how far it got, what
            stopped it, and what you can do about that. ───────────────────────────────────────── */}
        <div className="glass-card rounded-2xl border hairline p-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Project</div>
              <h1 className="mt-1 text-base leading-snug text-slate-100">{plan.goal}</h1>
              <div className="mt-1 text-[11px] text-slate-500">
                managed by {plan.manager.display_name}
                {plan.revision > 0 ? ` · revision ${plan.revision}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <PlanStateBadge state={plan.state} />
              <TurnMeter spent={plan.turnsSpent} max={plan.turnsMax} />
            </div>
          </div>

          {plan.tasks.length ? (
            <div className="mt-4">
              <ProgressTrack counts={counts} total={plan.tasks.length} />
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                <span className="text-slate-300">
                  {counts.done}/{plan.tasks.length} accepted
                </span>
                {counts.doing ? <span className="text-amber-400">{counts.doing} running</span> : null}
                {counts.review ? <span className="text-accent">{counts.review} in review</span> : null}
                {counts.blocked ? <span className="text-red-400">{counts.blocked} blocked</span> : null}
                {counts.todo ? <span>{counts.todo} to do</span> : null}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="mt-3">
              <Callout tone="error">{error}</Callout>
            </div>
          ) : null}

          {/* Why the scheduler stopped, verbatim. A project that says "needs you" without saying what
              for is a project the operator has to reconstruct by reading every task. */}
          {plan.escalation ? (
            <div className="mt-3">
              <Callout tone="warn" icon={<Sparkles size={13} />}>
                {plan.escalation}
              </Callout>
            </div>
          ) : null}

          {/* The primary move first and alone on the left; the rest quiet; Delete pushed away from
              both so it is never the button next to the one you meant. */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t hairline pt-3">
            {running ? (
              <Button
                icon={<Square size={13} />}
                loading={busy === 'stop'}
                onClick={() => act('stop', () => boardApi.patchPlan(plan.id, { state: 'draft' }))}
              >
                Pause
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Play size={13} />}
                loading={busy === 'start'}
                disabled={!plan.tasks.length}
                title={plan.tasks.length ? 'Dispatch every task whose dependencies are accepted' : 'Plan it first'}
                onClick={() => act('start', () => boardApi.patchPlan(plan.id, { state: 'running' }))}
              >
                Start
              </Button>
            )}
            <Button
              variant={plan.tasks.length ? 'ghost' : 'primary'}
              icon={<Wand2 size={13} />}
              loading={busy === 'plan'}
              onClick={() => act('plan', () => boardApi.runManager(plan.id, plan.escalation))}
            >
              {plan.tasks.length ? 'Replan' : 'Plan it'}
            </Button>
            <Button
              loading={busy === 'done'}
              onClick={() => act('done', () => boardApi.patchPlan(plan.id, { state: 'done' }))}
            >
              Close project
            </Button>
            <Button
              variant="danger"
              className="ml-auto"
              onClick={async () => {
                if (
                  await confirm({
                    title: 'Delete this project?',
                    body: 'Its tasks stop being dispatched. The threads and every deliverable posted on them stay on the forum.',
                    confirmLabel: 'Delete',
                  })
                ) {
                  await boardApi.deletePlan(plan.id);
                  nav('/board');
                }
              }}
            >
              Delete
            </Button>
          </div>
        </div>

        <Section
          title={`Tasks (${plan.tasks.length})`}
          icon={<ListChecks size={13} />}
          right={
            plan.tasks.length ? (
              <div className="flex items-center gap-1 rounded-lg raise-1 p-0.5">
                {FILTERS.map((f) => {
                  const n = plan.tasks.filter(f.match).length;
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
                        className={`ml-1 tabular-nums ${
                          f.id === 'attention' && n ? 'text-amber-400' : 'text-slate-500'
                        }`}
                      >
                        {n}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null
          }
        >
          {!plan.tasks.length ? (
            <EmptyState icon={<ListChecks size={20} />}>
              No tasks yet. Press <strong>Plan it</strong> — {plan.manager.display_name} breaks the goal
              into tasks with owners and acceptance criteria, and you read them before starting.
            </EmptyState>
          ) : null}

          {plan.tasks.length && !shown.length ? (
            <EmptyState>
              {filter === 'attention'
                ? 'Nothing is waiting on you — every task is either moving or accepted.'
                : 'No tasks in this view.'}
            </EmptyState>
          ) : null}

          {attention > 0 && filter !== 'attention' ? (
            <div className="mb-2">
              <Callout tone="warn">
                {attention === 1 ? '1 task is' : `${attention} tasks are`} waiting on you — they are
                opened below, and the{' '}
                <button className="underline underline-offset-2" onClick={() => setFilter('attention')}>
                  Needs you
                </button>{' '}
                filter shows only those.
              </Callout>
            </div>
          ) : null}

          <div className="space-y-2">
            {shown.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                byId={byId}
                open={open.has(task.id)}
                busy={busy}
                onToggle={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(task.id)) next.add(task.id);
                    return next;
                  })
                }
                act={act}
              />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

/**
 * One task. Closed it is a triage line; open it is the contract the reviewer signs against.
 *
 * The header is a single button so the whole line is the hit target, and every real action lives
 * *outside* it — a button inside a button is invalid markup and, worse, an accidental collapse
 * every time the operator means to accept something.
 */
function TaskCard({
  task,
  byId,
  open,
  busy,
  onToggle,
  act,
}: {
  task: BoardTask;
  byId: Map<string, BoardTask>;
  open: boolean;
  busy: string;
  onToggle: () => void;
  act: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  // The send-back reason, composed inline. It used to be a `window.prompt`, which gives the operator
  // one unstyled line to write the brief the owner is re-dispatched from — and nothing else to read
  // while writing it, since the dialog covers the criteria the verdict is about.
  const [reasons, setReasons] = useState<string | null>(null);
  const yours = needsOperator(task);
  const { tone } = TASK_STATES[task.state];
  const settled = task.state === 'done' || task.state === 'cancelled';

  return (
    <div
      className={`overflow-hidden rounded-xl border well backdrop-blur-sm transition-colors ${
        yours ? 'border-amber-500/30' : 'hairline'
      }`}
    >
      <div className="flex items-start gap-2 pr-2">
        <button
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-3 p-3 text-left transition-colors hover:raise-1"
        >
          <ChevronDown
            size={14}
            className={`mt-0.5 shrink-0 text-slate-500 transition-transform ${open ? '' : '-rotate-90'}`}
          />
          <span className="min-w-0 flex-1">
            <span
              className={`text-sm leading-snug ${settled ? 'text-slate-400' : 'text-slate-100'} ${
                open ? 'block' : 'line-clamp-2'
              }`}
            >
              {task.goal}
            </span>
            {/* Closed, this line is the entire card: who has it, how big the contract is, whether
                anything came back. Enough to decide not to open it. */}
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
              <span className={task.owner ? 'text-slate-400' : 'text-amber-400'}>
                {task.owner?.display_name ?? 'unowned'}
              </span>
              <span className="text-slate-600">→</span>
              <span>{task.reviewer?.display_name ?? 'you'}</span>
              <span className="text-slate-600">·</span>
              <span className={task.acceptance.length ? '' : 'text-amber-400'}>
                {task.acceptance.length || 'no'} criteria
              </span>
              {task.dependsOn.length ? <span>waits on {task.dependsOn.length}</span> : null}
              {task.reviewRounds > 0 ? <span className="text-amber-400">sent back {task.reviewRounds}×</span> : null}
              {task.deliverable ? <span className="text-emerald-400">delivered</span> : null}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2 py-3">
          {task.sessionId ? (
            <Link
              to={`/workspace?session=${task.sessionId}`}
              className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
              title="Open the conversation this task is running in"
            >
              <Radio size={11} className={task.inFlight ? 'animate-pulse' : ''} />
              watch run
            </Link>
          ) : null}
          <Link
            to={`/forum/t/${task.threadId}`}
            className="text-[11px] text-slate-500 transition-colors hover:text-slate-300"
          >
            thread
          </Link>
          <TaskStateBadge state={task.state} live={task.inFlight} />
        </div>
      </div>

      {open ? (
        <div className="space-y-3 border-t hairline p-3">
          {/* Criteria get the width — they are prose, and the two metadata columns are not. The old
              even three-column split gave a five-line criterion a third of the card and "nothing" the
              same third. */}
          <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Detail label="Accepted when">
              {task.acceptance.length ? (
                <ol className="space-y-1.5">
                  {task.acceptance.map((a, i) => (
                    <li key={i} className="flex gap-2 leading-relaxed">
                      <span className="mt-px shrink-0 font-mono text-[10px] text-slate-600">{i + 1}</span>
                      <span className="min-w-0">{a}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <span className="text-amber-400">no criteria — nobody can review this</span>
              )}
            </Detail>

            <div className="space-y-3">
              <Detail label="Waits on">
                {task.dependsOn.length ? (
                  <div className="flex flex-col gap-1">
                    {task.dependsOn.map((id) => {
                      const dep = byId.get(id);
                      return (
                        <span key={id} className="flex items-center gap-1.5">
                          {dep ? <TaskStateBadge state={dep.state} /> : null}
                          <span className="min-w-0 truncate text-[11px] text-slate-400">
                            {dep?.goal ?? id.slice(-6)}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <span className="text-slate-500">nothing</span>
                )}
              </Detail>
              {task.dispatchCount > 0 ? (
                <Detail label="Dispatched">
                  <Chip>{task.dispatchCount}×</Chip>
                </Detail>
              ) : null}
            </div>
          </div>

          {task.deliverable ? (
            <Detail label="Delivered">
              <DeliverableChip
                kind={task.deliverable.kind}
                refValue={task.deliverable.ref}
                note={task.deliverable.note}
              />
            </Detail>
          ) : null}

          {task.blockedOn ? <Callout tone="warn">{task.blockedOn}</Callout> : null}

          {/* The verdict form, when it is the operator's. Shown in place of the buttons so the two
              can't both be on screen claiming to be the next thing to do. */}
          {reasons !== null ? (
            <div className="space-y-2 rounded-lg hairline p-2.5">
              <Textarea
                rows={3}
                autoFocus
                placeholder="What is missing? The owner is re-dispatched from this alone — name the criterion it fails."
                value={reasons}
                onChange={(e) => setReasons(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  loading={busy === `fail${task.id}`}
                  disabled={!reasons.trim()}
                  onClick={async () => {
                    await act(`fail${task.id}`, () => boardApi.review(task.id, 'fail', reasons.trim()));
                    setReasons(null);
                  }}
                >
                  Send back
                </Button>
                <Button onClick={() => setReasons(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {/* Only ever offered when it is actually the operator's move: a task in review with
                  no agent reviewer would otherwise sit there forever. */}
              {task.state === 'review' && !task.reviewer ? (
                <>
                  <Button
                    variant="primary"
                    loading={busy === `pass${task.id}`}
                    onClick={() => act(`pass${task.id}`, () => boardApi.review(task.id, 'pass'))}
                  >
                    Accept
                  </Button>
                  <Button onClick={() => setReasons('')}>Send back</Button>
                </>
              ) : null}
              {!task.inFlight && !settled ? (
                <Button
                  icon={<Play size={13} />}
                  loading={busy === `run${task.id}`}
                  onClick={() =>
                    act(`run${task.id}`, () =>
                      boardApi.dispatch(task.id, task.state === 'review' ? 'review' : 'work'),
                    )
                  }
                >
                  Run now
                </Button>
              ) : null}
              {/* A claim outlives its run when the turn dies without saying so, and until it is
                  released the task reads as running with nothing behind it. */}
              {task.inFlight ? (
                <Button
                  icon={<Square size={13} />}
                  loading={busy === `release${task.id}`}
                  onClick={() => act(`release${task.id}`, () => boardApi.release(task.id))}
                  title="Stop the run and put the task back — for one that says it is running but is not"
                >
                  Force stop
                </Button>
              ) : null}
              {task.state === 'blocked' ? (
                <Button
                  loading={busy === `unblock${task.id}`}
                  onClick={() => act(`unblock${task.id}`, () => boardApi.patchTask(task.id, { state: 'todo' }))}
                >
                  Unblock
                </Button>
              ) : null}
              {tone === 'ok' && task.doneAt ? (
                <span className="self-center text-[11px] text-slate-600">
                  accepted {new Date(task.doneAt).toLocaleString()}
                </span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
