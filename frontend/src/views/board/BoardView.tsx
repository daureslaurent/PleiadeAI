import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ListChecks, Plus, Sparkles } from 'lucide-react';
import { boardApi, type BoardPlan } from '../../lib/api';
import { Button, Callout, EmptyState, Field, Row, Section, Spinner, Textarea } from '../../components/ui';
import { PlanStateBadge, TurnMeter } from './boardBits';

/**
 * The board's front page: every project, and what each one is waiting on.
 *
 * It is a list of *projects* rather than of tasks on purpose. A flat task list is what the forum
 * already was — a stream where the thing that has stopped moving looks exactly like the thing that
 * finished — and the question an operator actually has is "is anything stuck?", which is a per
 * project answer. The three counts on each card exist to answer it without opening anything.
 */
export function BoardView() {
  const nav = useNavigate();
  const [plans, setPlans] = useState<BoardPlan[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
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

  const create = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    setError('');
    try {
      const plan = await boardApi.createPlan({ goal: goal.trim() });
      setGoal('');
      setCreating(false);
      // Straight to the project: the next thing to do is always to plan it, and that button is there.
      nav(`/board/${plan.id}`);
    } catch (err) {
      setError(String((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? err));
    } finally {
      setBusy(false);
    }
  };

  if (!plans) return <Spinner />;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
        <Section
          title="Projects"
          icon={<ListChecks size={13} />}
          right={
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setCreating((v) => !v)}>
              New project
            </Button>
          }
        >
          <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
            A goal, broken into tasks with owners and acceptance criteria. The board dispatches each
            task when everything it waits on has been accepted — nobody has to remember to hand it on.
          </p>
          {error ? <Callout tone="error">{error}</Callout> : null}

          {creating ? (
            <div className="space-y-3 rounded-lg hairline p-3">
              <Field
                label="Goal"
                hint="Say what you want to exist when this is finished, in the words you would use to a person. The manager turns it into tasks."
              >
                <Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button variant="primary" loading={busy} onClick={create}>
                  Open project
                </Button>
                <Button onClick={() => setCreating(false)}>Cancel</Button>
              </div>
            </div>
          ) : null}

          {!plans.length && !creating ? (
            <EmptyState icon={<ListChecks size={20} />}>
              No projects yet. Open one with a goal — the project manager agent breaks it into tasks,
              and the board runs them.
            </EmptyState>
          ) : null}

          <div className="space-y-2">
            {plans.map((plan) => (
              <Row key={plan.id} className="p-3" onClick={() => nav(`/board/${plan.id}`)}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <PlanStateBadge state={plan.state} />
                    <span className="truncate text-sm text-slate-100">{plan.goal}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    <span>
                      {plan.doneCount ?? 0}/{plan.taskCount ?? 0} accepted
                    </span>
                    {plan.blockedCount ? <span className="text-red-400">{plan.blockedCount} blocked</span> : null}
                    <span>managed by {plan.manager.display_name}</span>
                    {plan.revision > 0 ? <span>revision {plan.revision}</span> : null}
                    <TurnMeter spent={plan.turnsSpent} max={plan.turnsMax} />
                  </div>
                  {/* The reason the scheduler gave up, verbatim. Without it, "needs you" is a colour. */}
                  {plan.escalation ? (
                    <div className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-400">
                      <Sparkles size={11} className="mt-0.5 shrink-0" />
                      <span className="min-w-0">{plan.escalation}</span>
                    </div>
                  ) : null}
                </div>
              </Row>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
