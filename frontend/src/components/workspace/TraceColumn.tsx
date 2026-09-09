import { Bug, Play, Square, CornerDownRight, Brain, TriangleAlert } from 'lucide-react';
import { useStream, type TraceEntry } from '../../store/stream';
import { useStickyScroll } from '../../hooks/useStickyScroll';

/**
 * The live execution trace: tool calls, cross-agent hops, `<think>` reasoning and alerts, in the
 * order they happened.
 *
 * `store/stream` already keeps this as a flat `TraceEntry[]` alongside the nested `Block[]` tree,
 * so a view that wants the machinery separated from the prose costs nothing to render. Two places
 * do: the debugger drawer's Trace tab, and the Workbench chat layout, where it is the whole right
 * half of the page rather than a panel you open (THEME_SYSTEM_PLAN.md §4).
 */

const KIND_META: Record<TraceEntry['kind'], { icon: typeof Play; tint: string; ring: string }> = {
  tool_start: { icon: Play, tint: 'text-sky-300', ring: 'ring-sky-500/20' },
  tool_end: { icon: Square, tint: 'text-emerald-300', ring: 'ring-emerald-500/20' },
  hop: { icon: CornerDownRight, tint: 'text-amber-300', ring: 'ring-amber-500/20' },
  reasoning: { icon: Brain, tint: 'text-reasoning', ring: 'ring-purple-500/20' },
  alert: { icon: TriangleAlert, tint: 'text-red-300', ring: 'ring-red-500/20' },
};

export function TraceCard({ entry }: { entry: TraceEntry }) {
  const meta = entry.status === 'error' ? KIND_META.alert : KIND_META[entry.kind];
  const Icon = meta.icon;
  return (
    <div className={`animate-fade-up rounded-xl well px-3 py-2 backdrop-blur-sm ring-1 ${meta.ring}`}>
      <div className="flex items-center gap-2">
        <Icon size={13} className={`shrink-0 ${meta.tint}`} />
        <span className={`min-w-0 flex-1 truncate font-mono text-xs ${meta.tint}`}>{entry.label}</span>
        {typeof entry.depth === 'number' && (
          <span className="shrink-0 rounded raise-2 px-1.5 py-0.5 text-[10px] text-slate-500">
            depth {entry.depth}
          </span>
        )}
      </div>
      {entry.detail && (
        <pre
          className={`mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words pl-5 font-mono text-[11px] leading-relaxed ${
            // Thinking is long-form prose, not a short arg/result dump — keep it on the reasoning
            // tint (as the old dedicated panel had it) so it stays readable at this size.
            entry.kind === 'reasoning' && entry.status !== 'error'
              ? 'text-purple-300/80'
              : 'text-slate-500'
          }`}
        >
          {entry.detail}
        </pre>
      )}
    </div>
  );
}

/**
 * The scrolling list of trace cards, pinned to the live end. `active` gates the sticky scroll so a
 * hidden tab doesn't fight the reader for the scroll position.
 */
export function TraceColumn({ active = true }: { active?: boolean }) {
  const trace = useStream((s) => s.trace);
  const { ref, onScroll } = useStickyScroll<HTMLDivElement>([trace], {
    enabled: active,
    behavior: 'smooth',
  });

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
      {/* Reasoning is threaded into `trace` in call order as it streams, so each thinking span
          renders as its own card between the tools it sits between — no trailing catch-all block. */}
      {trace.map((e, i) => (
        <TraceCard key={i} entry={e} />
      ))}

      {trace.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center text-slate-600">
          <Bug size={28} className="mb-2 text-slate-700" />
          <p className="text-xs">No trace yet. Send a message to watch live execution.</p>
        </div>
      )}
    </div>
  );
}
