import { useEffect, useRef, useState } from 'react';
import { Bug, X, Play, Square, CornerDownRight, Brain, TriangleAlert, Box, Database } from 'lucide-react';
import { useStream, type TraceEntry } from '../../store/stream';
import type { Agent } from '../../lib/api';
import { IsolationPanel } from './IsolationPanel';
import { DataPanel } from './DataPanel';

const KIND_META: Record<
  TraceEntry['kind'],
  { icon: typeof Play; tint: string; ring: string }
> = {
  tool_start: { icon: Play, tint: 'text-sky-300', ring: 'ring-sky-500/20' },
  tool_end: { icon: Square, tint: 'text-emerald-300', ring: 'ring-emerald-500/20' },
  hop: { icon: CornerDownRight, tint: 'text-amber-300', ring: 'ring-amber-500/20' },
  reasoning: { icon: Brain, tint: 'text-reasoning', ring: 'ring-purple-500/20' },
  alert: { icon: TriangleAlert, tint: 'text-red-300', ring: 'ring-red-500/20' },
};

function TraceCard({ entry }: { entry: TraceEntry }) {
  const meta = entry.status === 'error' ? KIND_META.alert : KIND_META[entry.kind];
  const Icon = meta.icon;
  return (
    <div className={`animate-fade-up rounded-xl bg-black/25 px-3 py-2 backdrop-blur-sm ring-1 ${meta.ring}`}>
      <div className="flex items-center gap-2">
        <Icon size={13} className={`shrink-0 ${meta.tint}`} />
        <span className={`min-w-0 flex-1 truncate font-mono text-xs ${meta.tint}`}>{entry.label}</span>
        {typeof entry.depth === 'number' && (
          <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-slate-500">
            depth {entry.depth}
          </span>
        )}
      </div>
      {entry.detail && (
        <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words pl-5 font-mono text-[11px] leading-relaxed text-slate-500">
          {entry.detail}
        </pre>
      )}
    </div>
  );
}

interface Props {
  onClose: () => void;
  agent: Agent | null;
}

type Tab = 'trace' | 'isolation' | 'data';

/**
 * Right drawer with three tabs: **Trace** (the live + persisted execution trace for the active
 * session — tool calls, cross-agent hops, `<think>` reasoning, alerts), **Isolation** (the active
 * agent's container: live usage + a `/workspace` file explorer), and **Data** (the session's
 * persisted resources — tool-read images and fetched binary blobs, by handle).
 */
export function DebuggerDrawer({ onClose, agent }: Props) {
  const { trace, liveReasoning, streaming } = useStream();
  const [tab, setTab] = useState<Tab>('trace');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (tab === 'trace') bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [trace, liveReasoning, tab]);

  const empty = !trace.length && !liveReasoning;

  return (
    <aside className="glass flex w-96 shrink-0 flex-col border-l">
      <div className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-1.5">
        <TabButton icon={Bug} label="Trace" active={tab === 'trace'} onClick={() => setTab('trace')}>
          {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
        </TabButton>
        <TabButton
          icon={Box}
          label="Isolation"
          active={tab === 'isolation'}
          onClick={() => setTab('isolation')}
        />
        <TabButton icon={Database} label="Data" active={tab === 'data'} onClick={() => setTab('data')} />
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-slate-500 hover:bg-white/[0.06] hover:text-slate-200"
        >
          <X size={15} />
        </button>
      </div>

      {tab === 'isolation' ? (
        <IsolationPanel agent={agent} />
      ) : tab === 'data' ? (
        <DataPanel />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {trace.map((e, i) => (
          <TraceCard key={i} entry={e} />
        ))}

        {/* Live reasoning for the in-flight turn (persisted into the trace once the turn ends). */}
        {liveReasoning && (
          <div className="animate-fade-up rounded-xl bg-black/25 px-3 py-2 backdrop-blur-sm ring-1 ring-purple-500/20">
            <div className="flex items-center gap-2">
              <Brain size={13} className="text-reasoning" />
              <span className="font-mono text-xs text-reasoning">&lt;think&gt;</span>
            </div>
            <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words pl-5 font-mono text-[11px] leading-relaxed text-purple-300/80">
              {liveReasoning}
            </pre>
          </div>
        )}

        {empty && (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-slate-600">
            <Bug size={28} className="mb-2 text-slate-700" />
            <p className="text-xs">No trace yet. Send a message to watch live execution.</p>
          </div>
        )}
        <div ref={bottomRef} />
        </div>
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
        active ? 'bg-reasoning/15 text-reasoning' : 'text-slate-400 hover:bg-white/[0.06] hover:text-slate-200',
      ].join(' ')}
    >
      <Icon size={14} /> {label}
      {children}
    </button>
  );
}
