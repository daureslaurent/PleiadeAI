import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Reusable master-detail scaffold: a scrollable list rail with a "New" action on the left,
 * and a detail/editor pane on the right. Shared by the Agents and Skills pages.
 */
export function MasterDetail({
  newLabel,
  onNew,
  list,
  children,
}: {
  newLabel: string;
  onNew: () => void;
  list: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
        <button
          onClick={onNew}
          className="m-2 flex items-center justify-center gap-1 rounded-md border border-dashed border-border py-2 text-sm text-slate-300 hover:border-accent hover:text-accent"
        >
          <Plus size={15} /> {newLabel}
        </button>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">{list}</div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">{children}</section>
    </div>
  );
}

/** A single selectable row in the master list. */
export function ListRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
        active ? 'bg-accent/15 text-accent' : 'text-slate-300 hover:bg-panel'
      }`}
    >
      {children}
    </button>
  );
}
