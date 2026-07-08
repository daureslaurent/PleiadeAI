import type { ReactNode } from 'react';

/**
 * On-glass surfaces (DIRECT_ART §3). `GlassCard` is the floating `rounded-2xl` panel every
 * non-workspace view is built from; `Section` adds the `[10px]` uppercase section label + an
 * optional right-hand slot for a badge or action.
 *
 * In-flow repeated rows must NOT use these (heavy backdrop-blur × N tanks paint time) — use
 * `Row` instead: a `bg-black/25` well with a hairline that brightens on hover.
 */
export function GlassCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`glass-card rounded-2xl border border-white/[0.06] ${className}`}>{children}</div>
  );
}

export function Section({
  title,
  icon,
  right,
  children,
  className = '',
}: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <GlassCard className={`p-4 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        {icon && <span className="shrink-0 text-slate-500">{icon}</span>}
        <h2 className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{title}</h2>
        {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
      </div>
      {children}
    </GlassCard>
  );
}

/** A repeated in-flow row (build jobs, containers, volumes, memories): lightweight glass. */
export function Row({
  children,
  className = '',
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const base =
    'rounded-xl border border-white/[0.06] bg-black/25 backdrop-blur-sm transition-colors hover:border-white/[0.12]';
  return onClick ? (
    <button onClick={onClick} className={`${base} w-full text-left ${className}`}>
      {children}
    </button>
  ) : (
    <div className={`${base} ${className}`}>{children}</div>
  );
}

/** A quiet stack of rows with hairline dividers, wrapped in one well. */
export function RowGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-white/[0.06] overflow-hidden rounded-xl border border-white/[0.06] bg-black/25">
      {children}
    </div>
  );
}

export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 p-8 text-center text-sm text-slate-600">
      {icon && <span className="opacity-50">{icon}</span>}
      <span>{children}</span>
    </div>
  );
}

/** Inline note / helper prose under a control. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-slate-500">{children}</p>;
}

/** Tinted callout for warnings and errors — semantic color only (DIRECT_ART §2). */
export function Callout({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'error' | 'info';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const tones = {
    warn: 'border-amber-500/25 bg-amber-500/[0.07] text-amber-300',
    error: 'border-red-500/25 bg-red-500/[0.07] text-red-300',
    info: 'border-accent/25 bg-accent/[0.07] text-slate-300',
  } as const;
  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed backdrop-blur-sm ${tones[tone]}`}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
