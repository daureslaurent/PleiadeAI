import { useState } from 'react';
import { Bug, X, Box, Database } from 'lucide-react';
import { useStream } from '../../store/stream';
import type { Agent } from '../../lib/api';
import { IsolationPanel } from './IsolationPanel';
import { DataPanel } from './DataPanel';
import { TraceColumn } from './TraceColumn';

interface Props {
  onClose: () => void;
  agent: Agent | null;
  /** The chat layout already docks the trace beside the conversation — don't offer it twice. */
  hideTrace?: boolean;
}

type Tab = 'trace' | 'isolation' | 'data';

/**
 * Right drawer with three tabs: **Trace** (the live + persisted execution trace for the active
 * session — tool calls, cross-agent hops, `<think>` reasoning, alerts), **Isolation** (the active
 * agent's container: live usage + a `/workspace` file explorer), and **Data** (the session's
 * persisted resources — tool-read images and fetched binary blobs, by handle).
 */
export function DebuggerDrawer({ onClose, agent, hideTrace = false }: Props) {
  const streaming = useStream((s) => s.streaming);
  const [tab, setTab] = useState<Tab>(hideTrace ? 'isolation' : 'trace');

  return (
    <aside className="glass flex w-96 shrink-0 flex-col border-l">
      <div className="flex items-center gap-1 border-b hairline px-2 py-1.5">
        {!hideTrace && (
          <TabButton icon={Bug} label="Trace" active={tab === 'trace'} onClick={() => setTab('trace')}>
            {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
          </TabButton>
        )}
        <TabButton
          icon={Box}
          label="Isolation"
          active={tab === 'isolation'}
          onClick={() => setTab('isolation')}
        />
        <TabButton icon={Database} label="Data" active={tab === 'data'} onClick={() => setTab('data')} />
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-slate-500 hover:raise-2 hover:text-slate-200"
        >
          <X size={15} />
        </button>
      </div>

      {tab === 'isolation' ? (
        <IsolationPanel agent={agent} />
      ) : tab === 'data' ? (
        <DataPanel />
      ) : hideTrace ? (
        <IsolationPanel agent={agent} />
      ) : (
        <TraceColumn active={tab === 'trace'} />
      )}
    </aside>
  );
}

function TabButton({
  icon: Icon,
  label,
  active,
  onClick,
  children,
}: {
  icon: typeof Bug;
  label: string;
  active: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-reasoning/15 text-reasoning' : 'text-slate-400 hover:raise-2 hover:text-slate-200',
      ].join(' ')}
    >
      <Icon size={14} /> {label}
      {children}
    </button>
  );
}
