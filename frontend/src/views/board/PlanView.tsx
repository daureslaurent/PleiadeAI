import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquareText, Play, Sparkles, Square, Wand2 } from 'lucide-react';
import { boardApi, type BoardPlan, type BoardTask } from '../../lib/api';
import { Button, Callout, Chip, EmptyState, Row, Section, Spinner } from '../../components/ui';
import { useConfirm } from '../../components/ui';
import { DeliverableChip, Detail, PlanStateBadge, TaskStateBadge, TurnMeter } from './boardBits';

/**
 * One project: its graph, and the two things only the operator can do to it.
 *
 * The page is built around reading the plan *before* it runs. The manager is an LLM and a bad plan
 * dispatches exactly as confidently as a good one, so a project stays `draft` until Start is pressed
 * here — and what is worth reading in a draft is precisely what this page leads with: each task's
 * acceptance criteria, its owner, its reviewer, and what it waits on.
 */
export function PlanView() {
  const { planId = '' } = useParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [plan, setPlan] = useState<(BoardPlan & { tasks: BoardTask[] }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

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

  if (!plan) return error ? <Callout tone="error">{error}</Callout> : <Spinner />;

  const done = plan.tasks.filter((t) => t.state === 'done').length;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Button icon={<ArrowLeft size={13} />} onClick={() => nav('/board')}>
            Projects
          </Button>
          <Link to={`/forum/t/${plan.hubThreadId}`} className="text-[11px] text-slate-500 hover:text-slate-300">
            <MessageSquareText size={11} className="mr-1 inline" />
            project thread
          </Link>
        </div>

        <Section
          title="Project"
          right={
            <div className="flex items-center gap-2">
              <TurnMeter spent={plan.turnsSpent} max={plan.turnsMax} />
              <PlanStateBadge state={plan.state} />
            </div>
          }
        >
          <h1 className="text-sm text-slate-100">{plan.goal}</h1>
          <div className="mt-1 text-[11px] text-slate-500">
            managed by {plan.manager.display_name} · {done}/{plan.tasks.length} accepted
            {plan.revision > 0 ? ` · revision ${plan.revision}` : ''}
          </div>

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

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              icon={<Wand2 size={13} />}
              loading={busy === 'plan'}
              onClick={() => act('plan', () => boardApi.runManager(plan.id, plan.escalation))}
            >
              {plan.tasks.length ? 'Replan' : 'Plan it'}
            </Button>
            {plan.state === 'running' ? (
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
                onClick={() => act('start', () => boardApi.patchPlan(plan.id, { state: 'running' }))}
              >
                Start
              </Button>
            )}
            <Button
              loading={busy === 'done'}
              onClick={() => act('done', () => boardApi.patchPlan(plan.id, { state: 'done' }))}
            >
              Close project
            </Button>
            <Button
              className="ml-auto text-red-400"
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
        </Section>

        <Section title={`Tasks (${plan.tasks.length})`}>
          {!plan.tasks.length ? (
            <EmptyState>
              No tasks yet. Press <strong>Plan it</strong> — {plan.manager.display_name} breaks the goal
              into tasks with owners and acceptance criteria, and you read them before starting.
            </EmptyState>
          ) : null}
          <div className="space-y-2">
            {plan.tasks.map((task) => (
              <Row key={task.id} className="p-3">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <TaskStateBadge state={task.state} live={task.inFlight} />
                    <span className="min-w-0 flex-1 text-sm text-slate-100">{task.goal}</span>
                    {task.sessionId ? (
                      <Link
                        to={`/chat/${task.sessionId}`}
                        className="text-[11px] text-accent hover:underline"
                        title="The session this task is running in"
                      >
                        watch run
                      </Link>
                    ) : null}
                    <Link to={`/forum/t/${task.threadId}`} className="text-[11px] text-slate-500 hover:text-slate-300">
                      thread
                    </Link>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-3">
                    <Detail label="Done when">
                      {task.acceptance.length ? (
                        <ul className="space-y-0.5">
                          {task.acceptance.map((a, i) => (
                            <li key={i} className="flex gap-1.5">
                              <span className="text-slate-600">·</span>
                              <span className="min-w-0">{a}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-amber-400">no criteria — nobody can review this</span>
                      )}
                    </Detail>
                    <Detail label="Who">
                      <div>{task.owner?.display_name ?? <span className="text-amber-400">unowned</span>}</div>
                      <div className="text-slate-500">
                        reviewed by {task.reviewer?.display_name ?? 'you'}
                        {task.reviewRounds > 0 ? ` · sent back ${task.reviewRounds}×` : ''}
                      </div>
                    </Detail>
                    <Detail label="Waits on">
                      {task.dependsOn.length ? (
                        <div className="flex flex-wrap gap-1">
                          {task.dependsOn.map((id) => (
                            <Chip key={id}>{byId.get(id)?.goal.slice(0, 28) ?? id.slice(-6)}</Chip>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-500">nothing</span>
                      )}
                    </Detail>
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
                        <Button
                          loading={busy === `fail${task.id}`}
                          onClick={async () => {
                            const reasons = window.prompt('What is missing? The owner is re-dispatched from this alone.');
                            if (reasons?.trim()) {
                              await act(`fail${task.id}`, () => boardApi.review(task.id, 'fail', reasons.trim()));
                            }
                          }}
                        >
                          Send back
                        </Button>
                      </>
                    ) : null}
                    {!task.inFlight && task.state !== 'done' && task.state !== 'cancelled' ? (
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
                  </div>
                </div>
              </Row>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
