import { useEffect, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import type { RecalledMemory } from '../store/stream';

/**
 * The memories an agent auto-recalled from its vector store and injected into this run's prompt,
 * shown as a small pill on the turn (and on a sub-agent's bubble) that opens a popover listing them.
 *
 * Purple per DIRECT_ART: recall is cognition — the same family as the `<think>` block — not an action
 * or a tool. The pill only exists when memory actually shaped the answer, so its presence is the
 * signal; the popover exists so the operator can judge *whether the recall was any good* (each entry
 * carries its similarity to the query, how it was written, and its age).
 */

/**
 * How the memory came to exist. `distiller` = the agent's own model rewrote a finished turn into it;
 * `remember_tool` = the agent deliberately chose to save it mid-turn; `auto_turn` = the legacy raw
 * whole-transcript capture (no longer written — anything still tagged this way is old junk).
 */
function sourceLabel(source?: string): string {
  if (source === 'remember_tool' || source === 'remember') return 'saved';
  if (source === 'distiller') return 'distilled';
  if (source === 'auto_turn') return 'legacy';
  return source || 'unknown';
}

/** Each kind reads differently to the model, so label it plainly for the operator too. */
const KIND_LABEL: Record<string, string> = {
  fact: 'fact',
  preference: 'preference',
  procedure: 'how-to',
  episode: 'episode',
};

/** Compact age: "3d", "5h", "just now". */
function fmtAge(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function MemoryItem({ memory }: { memory: RecalledMemory }) {
  const [open, setOpen] = useState(false);
  // Show the *similarity*, not the composite rerank score: "how much is this actually about my
  // question" is what the operator needs to judge the recall. The rerank score is why it ranked
  // where it did, which is a different question — it rides in the tooltip.
  const sim = memory.similarity ?? memory.score;
  const pct = Math.round(Math.max(0, Math.min(1, sim)) * 100);
  const rank = Math.round(Math.max(0, Math.min(1, memory.score)) * 100);
  const age = fmtAge(memory.createdAt);
  // A weak match is the tell that recall pulled in noise — say so rather than dressing it up.
  const weak = pct < 60;
  const kind = memory.kind ? (KIND_LABEL[memory.kind] ?? memory.kind) : null;

  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="w-full rounded-xl border border-white/[0.06] bg-white/[0.03] p-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05]"
    >
      <div className="mb-1 flex items-center gap-2 text-[10px]">
        {kind && (
          <span
            className="rounded bg-reasoning/15 px-1 py-px font-mono uppercase tracking-wide text-reasoning"
            title={memory.subject ? `Subject: ${memory.subject}` : undefined}
          >
            {kind}
          </span>
        )}
        <span
          className="rounded bg-white/[0.06] px-1 py-px font-mono uppercase tracking-wide text-slate-500"
          title={`How this memory was written (${memory.source ?? 'unknown'})`}
        >
          {sourceLabel(memory.source)}
        </span>
        <span
          className="flex items-center gap-1.5"
          title={`Similarity to this turn's query: ${pct}% · rerank score ${rank}%${
            memory.importance ? ` · importance ${memory.importance}/5` : ''
          }`}
        >
          <span className="h-1 w-10 overflow-hidden rounded-full bg-white/[0.06]">
            <span
              className={`block h-full rounded-full ${weak ? 'bg-slate-600' : 'bg-reasoning'}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className={`font-mono tabular-nums ${weak ? 'text-slate-600' : 'text-reasoning/80'}`}>
            {pct}%
          </span>
        </span>
        {age && <span className="ml-auto text-slate-600">{age}</span>}
      </div>
      <p
        className={[
          'whitespace-pre-wrap break-words text-[11px] leading-relaxed text-slate-400',
          open ? 'max-h-56 overflow-y-auto' : 'line-clamp-3',
        ].join(' ')}
      >
        {memory.text}
      </p>
    </button>
  );
}

export function MemoriesBadge({ memories }: { memories: RecalledMemory[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape — the popover is transient context, never a mode to get stuck in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!memories.length) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} recalled into this turn's prompt`}
        className={[
          'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
          open
            ? 'border-reasoning/40 bg-reasoning/20 text-reasoning'
            : 'border-reasoning/25 bg-reasoning/10 text-reasoning/90 hover:bg-reasoning/20',
        ].join(' ')}
      >
        <Database size={10} className="shrink-0" />
        <span className="font-mono tabular-nums">{memories.length}</span>
        <span>memor{memories.length === 1 ? 'y' : 'ies'}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Memories recalled into this turn"
          className="glass-card absolute left-0 top-full z-30 mt-1.5 w-[min(24rem,calc(100vw-3rem))] animate-fade-up rounded-2xl border p-2.5"
        >
          <p className="mb-2 px-0.5 text-[10px] uppercase tracking-wide text-slate-500">
            Recalled into the prompt · ranked
          </p>
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {memories.map((m, i) => (
              <MemoryItem key={i} memory={m} />
            ))}
          </div>
          <p className="mt-2 px-0.5 text-[10px] leading-relaxed text-slate-600">
            The agent was told to treat these as recollection, not instruction.
          </p>
        </div>
      )}
    </div>
  );
}
