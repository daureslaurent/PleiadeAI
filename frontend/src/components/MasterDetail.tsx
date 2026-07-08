import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Reusable master-detail scaffold: a scrollable glass rail with a "New" action on the left, and a
 * detail/editor pane on the right. Shared by the Agents, Skills, Images, and Isolation pages.
 *
 * The rail is `.glass` chrome over the app backdrop (DIRECT_ART §3); the detail pane stays
 * transparent so the starfield reads through the cards the views float on it.
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
      <aside className="glass flex w-64 shrink-0 flex-col border-r">
        <button
          onClick={onNew}
          className="m-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/[0.12] py-2 text-sm text-slate-400 transition-colors hover:border-accent/50 hover:bg-accent/[0.06] hover:text-accent active:scale-95"
        >
          <Plus size={15} /> {newLabel}
        </button>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">{list}</div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto">{children}</section>
    </div>
  );
}

/**
 * A single selectable row in the master list. The active state copies the workspace nav idiom
 * (DIRECT_ART §7): an `accent/15` fill with a 2px inset accent rail.
 */
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
      className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
        active
          ? 'bg-accent/15 text-accent shadow-[inset_2px_0_0_0_rgba(59,130,246,0.7)]'
          : 'text-slate-300 hover:bg-white/[0.05]'
      }`}
    >
      {children}
    </button>
  );
}

/** Hairline separator between groups of rows in the rail. */
export function ListDivider() {
  return <div className="my-1 border-t border-white/[0.06]" />;
}
