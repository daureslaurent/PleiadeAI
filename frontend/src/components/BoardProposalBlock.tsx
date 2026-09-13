import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquareDiff } from 'lucide-react';
import { boardApi, type BoardProposal } from '../lib/api';
import { StatusBadge, type Tone } from './ui';

/** Same name the board page fires when a proposal is decided (`views/board/ProposalCard.tsx`). */
const PROPOSAL_CHANGED_EVENT = 'board:proposal-changed';

const TONE: Record<BoardProposal['state'], Tone> = {
  pending: 'accent',
  applied: 'ok',
  partial: 'busy',
  rejected: 'idle',
  superseded: 'idle',
};

/**
 * A manager's `board` `propose` call, as it sits in the conversation (`BOARD_REFACTOR_PLAN.md` §6).
 *
 * Read-only on purpose. The checklist that decides it lives on the item's page, pinned above the
 * chat — two live Apply buttons for one proposal, a scroll apart, is one too many. This card says
 * what was proposed and what became of it, and links there when it is still open.
 */
export function BoardProposalBlock({ proposalId, changes }: { proposalId: string; changes: string[] }) {
  const [proposal, setProposal] = useState<BoardProposal | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      boardApi
        .proposal(proposalId)
        .then((p) => alive && setProposal(p))
        .catch(() => {});
    load();
    const onChange = (e: Event) => {
      if ((e as CustomEvent<string>).detail === proposalId) load();
    };
    window.addEventListener(PROPOSAL_CHANGED_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(PROPOSAL_CHANGED_EVENT, onChange);
    };
  }, [proposalId]);

  const lines = proposal ? proposal.ops.map((o) => ({ key: o.opId, text: label(o), status: o.status })) : changes.map((c, i) => ({ key: String(i), text: c, status: null }));

  return (
    <div className="my-2 animate-fade-up rounded-xl border hairline raise-1 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <MessageSquareDiff size={13} className="shrink-0 text-accent" />
        <span className="font-medium text-slate-200">Proposed changes</span>
        {proposal ? <StatusBadge tone={TONE[proposal.state]}>{proposal.state}</StatusBadge> : null}
        {proposal?.state === 'pending' ? (
          <Link to={`/board/${proposal.planId}`} className="ml-auto text-[11px] text-accent hover:underline">
            review
          </Link>
        ) : null}
      </div>
      {proposal?.summary ? <div className="mt-1 text-[11px] text-slate-300">{proposal.summary}</div> : null}
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-400">
        {lines.map((l) => (
          <li key={l.key} className="flex gap-1.5">
            <span className="shrink-0 text-slate-600">{l.status === 'applied' ? '✓' : l.status === 'failed' ? '!' : l.status === 'rejected' ? '–' : '•'}</span>
            <span className={`min-w-0 ${l.status === 'rejected' ? 'line-through' : ''}`}>{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function label(o: BoardProposal['ops'][number]): string {
  switch (o.op) {
    case 'add_task':
      return `add task: ${o.args.goal ?? ''}`;
    case 'cancel_task':
      return `cancel task ${o.taskId.slice(-6)}`;
    case 'patch_task':
      return `edit task ${o.taskId.slice(-6)}: ${Object.keys(o.args).join(', ')}`;
    default:
      return `edit item: ${Object.keys(o.args).join(', ')}`;
  }
}
