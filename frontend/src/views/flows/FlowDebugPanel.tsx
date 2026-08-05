import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Copy, Filter, Trash2 } from 'lucide-react';
import { EmptyState } from '../../components/ui';
import type { FlowLogSource, FlowNode } from '../../lib/api';
import type { LogLine } from './useFlowRun';

/** One colour per source, so you can tell the agent's reasoning from a tool's stdout at a glance. */
const SOURCE_COLOR: Record<FlowLogSource, string> = {
  node: 'text-slate-300',
  agent: 'text-sky-300/90',
  tool: 'text-amber-300/90',
  media: 'text-violet-300/90',
  system: 'text-slate-500',
};

const SOURCE_LABEL: Record<FlowLogSource, string> = {
  node: 'node',
  agent: 'agent',
  tool: 'tool',
  media: 'media',
  system: 'run',
};

/**
 * The run's debug stream (flows spec §6.2).
 *
 * One chronological list across every node, because the bug is usually in the *ordering* — which
 * node ran before which, and what the agent was saying while a render was queued. Per-node buckets
 * can't show that. Selecting a node on the canvas filters to it without losing the full view.
 */
export function FlowDebugPanel({
  logs,
  nodes,
  selectedNodeId,
  live,
}: {
  logs: LogLine[];
  nodes: FlowNode[];
  selectedNodeId: string | null;
  live: boolean;
}) {
  const [filterNode, setFilterNode] = useState<string | null>(null);
  const [muted, setMuted] = useState<Set<FlowLogSource>>(new Set());
  const [pinned, setPinned] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.id, n.label || n.type);
    return map;
  }, [nodes]);

  // Clicking a node on the canvas narrows the stream — the common move when something looks wrong.
  useEffect(() => {
    if (selectedNodeId) setFilterNode(selectedNodeId);
  }, [selectedNodeId]);

  const shown = useMemo(
    () => logs.filter((l) => (!filterNode || l.nodeId === filterNode) && !muted.has(l.source)),
    [logs, filterNode, muted],
  );

  // Follow the tail while pinned; unpin the moment the operator scrolls up to read something.
  useEffect(() => {
    if (!pinned || !scroller.current) return;
    scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [shown, pinned]);

  const toggleSource = (source: FlowLogSource) =>
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });

  const copyAll = () => {
    const text = shown
      .map((l) => `${time(l.at)} ${labels.get(l.nodeId) ?? l.nodeId}\t${l.text}`)
      .join('\n');
    void navigator.clipboard?.writeText(text);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1.5 border-b border-white/[0.06] p-2">
        <div className="flex items-center gap-1.5">
          <Filter size={11} className="shrink-0 text-slate-600" />
          <select
            value={filterNode ?? ''}
            onChange={(e) => setFilterNode(e.target.value || null)}
            className="min-w-0 flex-1 rounded border border-white/[0.1] bg-black/30 px-1.5 py-1 text-[11px] text-slate-300 outline-none focus:border-accent/50"
          >
            <option value="">All nodes</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label || n.type}
              </option>
            ))}
          </select>
          <button
            onClick={copyAll}
            title="Copy visible lines"
            className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
          >
            <Copy size={11} />
          </button>
          <button
            onClick={() => setPinned((p) => !p)}
            title={pinned ? 'Following the tail' : 'Scroll-lock released'}
            className={`shrink-0 rounded p-1 transition-colors hover:bg-white/[0.06] ${
              pinned ? 'text-accent' : 'text-slate-600'
            }`}
          >
            <ArrowDownToLine size={11} />
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          {(Object.keys(SOURCE_LABEL) as FlowLogSource[]).map((source) => (
            <button
              key={source}
              onClick={() => toggleSource(source)}
              className={`rounded px-1.5 py-0.5 text-[9px] transition-colors ${
                muted.has(source)
                  ? 'bg-white/[0.03] text-slate-700 line-through'
                  : `bg-white/[0.06] ${SOURCE_COLOR[source]}`
              }`}
            >
              {SOURCE_LABEL[source]}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[10px] leading-relaxed"
      >
        {shown.length === 0 ? (
          <EmptyState>
            {logs.length === 0
              ? live
                ? 'Waiting for output…'
                : 'No output recorded for this run.'
              : 'Nothing matches this filter.'}
          </EmptyState>
        ) : (
          shown.map((l) => (
            <div key={l.id} className="flex gap-1.5 border-b border-white/[0.03] py-0.5 last:border-0">
              <span className="shrink-0 text-slate-700">{time(l.at)}</span>
              {!filterNode && (
                <span className="w-16 shrink-0 truncate text-slate-600" title={labels.get(l.nodeId) ?? l.nodeId}>
                  {labels.get(l.nodeId) ?? l.nodeId}
                </span>
              )}
              {l.iteration != null && <span className="shrink-0 text-slate-700">#{l.iteration + 1}</span>}
              <span className={`min-w-0 whitespace-pre-wrap break-words ${SOURCE_COLOR[l.source]}`}>{l.text}</span>
            </div>
          ))
        )}
      </div>

      {filterNode && (
        <button
          onClick={() => setFilterNode(null)}
          className="flex items-center justify-center gap-1 border-t border-white/[0.06] py-1.5 text-[10px] text-slate-500 transition-colors hover:text-accent"
        >
          <Trash2 size={10} /> Clear filter ({logs.length - shown.length} hidden)
        </button>
      )}
    </div>
  );
}

function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--:--'
    : d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
