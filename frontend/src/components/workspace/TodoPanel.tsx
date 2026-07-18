import { Check, ChevronDown, ChevronRight, ListChecks, X } from 'lucide-react';
import { usePersistentState } from '../../hooks/usePersistentState';
import type { TodoItem } from '../../lib/ws-events.types';

/** Per-item glyph + text treatment. `in_progress` is the one the operator's eye should land on. */
function ItemRow({ item }: { item: TodoItem }) {
  if (item.status === 'completed') {
    return (
      <li className="flex items-start gap-2 text-[12px] leading-snug text-slate-500">
        <Check size={13} className="mt-px shrink-0 text-emerald-400/80" />
        <span className="line-through decoration-slate-600">{item.content}</span>
      </li>
    );
  }
  if (item.status === 'in_progress') {
    return (
      <li className="flex items-start gap-2 text-[12px] font-medium leading-snug text-slate-100">
        <span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]" />
        </span>
        <span>{item.content}</span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-[12px] leading-snug text-slate-400">
      <span className="mt-1 h-3 w-3 shrink-0 rounded-full border border-slate-600" />
      <span>{item.content}</span>
    </li>
  );
}

/**
 * Compact checklist used inside a delegated sub-agent's bubble, where vertical space is tight and the
 * list is context rather than the thing you are tracking.
 */
export function TodoList({ items }: { items: TodoItem[] }) {
  if (!items.length) return null;
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        <ListChecks size={11} /> tasks
        <span className="font-normal normal-case tracking-normal text-slate-600">
          {done}/{items.length}
        </span>
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <ItemRow key={it.id} item={it} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The pinned task list for the session's agent (`todowrite`), sitting above the composer so the plan
 * stays in view while the turn runs — the point being to watch steps get ticked off without scrolling
 * back through the transcript.
 *
 * Shown while any item is outstanding and hidden once everything is complete: a finished list is
 * history, and history belongs in the scrollback. Collapse and dismiss are operator preferences only
 * (persisted to localStorage) — the panel is read-only, so there is no way for a click here to race
 * an in-flight turn. Dismissal is keyed by session and resets when the agent writes a new list.
 */
export function TodoPanel({ items, sessionId }: { items: TodoItem[]; sessionId: string }) {
  const [collapsed, setCollapsed] = usePersistentState('todo-panel-collapsed', false);
  // Keyed by the list's shape, so dismissing hides *this* list but a later rewrite brings the panel
  // back — otherwise one dismissal would blind the operator for the rest of the session.
  const signature = `${sessionId}:${items.map((i) => `${i.id}${i.status}`).join(',')}`;
  const [dismissed, setDismissed] = usePersistentState<string | null>('todo-panel-dismissed', null);

  const done = items.filter((i) => i.status === 'completed').length;
  const active = items.find((i) => i.status === 'in_progress');

  if (!items.length || done === items.length || dismissed === signature) return null;

  return (
    <div className="px-4 pt-3">
      <div className="glass-card mx-auto max-w-3xl animate-fade-up rounded-2xl border p-2.5">
        <div className="flex items-center gap-2 px-1">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] font-medium text-slate-300 transition-colors hover:text-slate-100"
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <ListChecks size={13} className="shrink-0 text-accent" />
            <span>Task list</span>
            <span className="shrink-0 text-slate-500">
              {done}/{items.length}
            </span>
            {/* Collapsed, the panel still has to answer "what is it doing right now". */}
            {collapsed && active && (
              <span className="min-w-0 truncate text-slate-400">— {active.content}</span>
            )}
          </button>
          <button
            onClick={() => setDismissed(signature)}
            title="Hide until the list changes"
            className="shrink-0 rounded p-1 text-slate-600 transition-colors hover:text-slate-300"
          >
            <X size={13} />
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="mx-1 my-2 h-px bg-white/[0.06]" />
            <ul className="space-y-1.5 px-1">
              {items.map((it) => (
                <ItemRow key={it.id} item={it} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
