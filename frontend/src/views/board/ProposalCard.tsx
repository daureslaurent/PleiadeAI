import { useEffect, useState } from 'react';
import { Ban, Check, FilePlus2, MessageSquareDiff, PencilLine, X } from 'lucide-react';
import { boardApi, type BoardProposal, type BoardProposalOp, type BoardTask } from '../../lib/api';
import { Button, Callout, StatusBadge, type Tone } from '../../components/ui';

/** Fired whenever a proposal is decided, so every card showing it (the chat's inline one too) refreshes. */
export const PROPOSAL_CHANGED_EVENT = 'board:proposal-changed';

const STATUS_TONE: Record<BoardProposalOp['status'], Tone> = {
  pending: 'idle',
  applied: 'ok',
  rejected: 'idle',
  failed: 'error',
};

/**
 * The manager's proposed changes, as a checklist (`BOARD_REFACTOR_PLAN.md` §6 of the frontend).
 *
 * Every line is one concrete edit with its own box, because what the operator asked for in prose is
 * rarely *exactly* what came back: three of the four changes are right and one invents a task nobody
 * wanted. Apply selected keeps the three; the manager sees which line was left out on its next turn.
 */
export function ProposalCard({
  proposal,
  tasks,
  onDecided,
}: {
  proposal: BoardProposal;
  tasks: BoardTask[];
  onDecided: (p: BoardProposal) => void;
}) {
  const pending = proposal.state === 'pending';
  const [picked, setPicked] = useState<Set<string>>(() => new Set(proposal.ops.map((o) => o.opId)));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => setPicked(new Set(proposal.ops.map((o) => o.opId))), [proposal.id, proposal.ops]);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byRef = new Map(proposal.ops.filter((o) => o.ref).map((o) => [o.ref, o]));
  const depLabel = (d: string) => byId.get(d)?.goal ?? (byRef.get(d)?.args.goal ? `new: ${byRef.get(d)?.args.goal}` : d);

  const decide = async (label: string, fn: () => Promise<BoardProposal>) => {
    setBusy(label);
    setError('');
    try {
      const next = await fn();
      onDecided(next);
      window.dispatchEvent(new CustomEvent(PROPOSAL_CHANGED_EVENT, { detail: next.id }));
    } catch (err) {
      setError(String((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={`rounded-xl border ${pending ? 'border-accent/30' : 'hairline'} well p-3`}>
      <div className="mb-2 flex items-start gap-2">
        <MessageSquareDiff size={14} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
            {pending ? 'Proposed changes' : `Proposal ${proposal.state}`}
          </div>
          {proposal.summary ? <div className="mt-0.5 text-xs leading-relaxed text-slate-200">{proposal.summary}</div> : null}
        </div>
      </div>

      <ul className="space-y-1.5">
        {proposal.ops.map((op) => (
          <li key={op.opId} className="flex items-start gap-2 rounded-lg raise-1 px-2 py-1.5">
            {pending ? (
              <input
                type="checkbox"
                checked={picked.has(op.opId)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(op.opId);
                    else next.delete(op.opId);
                    return next;
                  })
                }
                className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                aria-label="Include this change"
              />
            ) : (
              <StatusBadge tone={STATUS_TONE[op.status]} className="mt-0.5">
                {op.status}
              </StatusBadge>
            )}
            <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-300">
              <OpBody op={op} task={byId.get(op.taskId)} depLabel={depLabel} />
              {op.why ? <div className="mt-0.5 text-slate-500">{op.why}</div> : null}
              {op.error ? <div className="mt-0.5 text-red-400">{op.error}</div> : null}
            </div>
          </li>
        ))}
      </ul>

      {error ? (
        <div className="mt-2">
          <Callout tone="error">{error}</Callout>
        </div>
      ) : null}

      {pending ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<Check size={13} />}
            loading={busy === 'selected'}
            disabled={!picked.size || Boolean(busy)}
            onClick={() => decide('selected', () => boardApi.applyProposal(proposal.id, [...picked]))}
          >
            Apply {picked.size === proposal.ops.length ? 'all' : `${picked.size} selected`}
          </Button>
          <Button
            icon={<X size={13} />}
            loading={busy === 'reject'}
            disabled={Boolean(busy)}
            onClick={() => decide('reject', () => boardApi.rejectProposal(proposal.id))}
          >
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OpBody({
  op,
  task,
  depLabel,
}: {
  op: BoardProposalOp;
  task?: BoardTask;
  depLabel: (id: string) => string;
}) {
  const a = op.args;
  if (op.op === 'add_task') {
    return (
      <>
        <div className="flex items-start gap-1.5">
          <FilePlus2 size={12} className="mt-0.5 shrink-0 text-emerald-400" />
          <span className="text-slate-100">{a.goal}</span>
        </div>
        <div className="mt-0.5 text-slate-500">
          {a.owner || 'unowned'} → {a.reviewer || 'manager'}
          {a.depends_on?.length ? ` · waits on ${a.depends_on.map(depLabel).join('; ')}` : ''}
        </div>
        {a.acceptance?.length ? (
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-slate-400">
            {a.acceptance.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        ) : null}
      </>
    );
  }
  if (op.op === 'cancel_task') {
    return (
      <div className="flex items-start gap-1.5">
        <Ban size={12} className="mt-0.5 shrink-0 text-red-400" />
        <span>
          Cancel <span className="text-slate-100">{task?.goal ?? op.taskId}</span>
        </span>
      </div>
    );
  }
  const title = op.op === 'patch_plan' ? 'Edit this item' : `Edit ${task?.goal ?? op.taskId}`;
  const before: Record<string, unknown> =
    op.op === 'patch_task' && task
      ? {
          goal: task.goal,
          acceptance: task.acceptance,
          owner: task.owner?.display_name ?? '',
          reviewer: task.reviewer?.display_name ?? '',
          depends_on: task.dependsOn,
        }
      : {};
  const show = (k: string, v: unknown) =>
    Array.isArray(v) ? (k === 'depends_on' ? v.map((d) => depLabel(String(d))).join('; ') : v.join(' · ')) || '—' : String(v || '—');
  return (
    <>
      <div className="flex items-start gap-1.5">
        <PencilLine size={12} className="mt-0.5 shrink-0 text-amber-400" />
        <span className="text-slate-100">{title}</span>
      </div>
      <dl className="mt-1 space-y-0.5">
        {Object.entries(a).map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-x-1.5">
            <dt className="text-slate-500">{k.replace('_', ' ')}:</dt>
            {k in before ? <dd className="text-slate-500 line-through">{show(k, before[k])}</dd> : null}
            <dd className="min-w-0 text-slate-200">{show(k, v)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
