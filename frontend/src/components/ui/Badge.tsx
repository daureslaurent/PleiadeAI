import type { ReactNode } from 'react';

/**
 * The single status vocabulary for the app (DIRECT_ART §2 — semantic color, never decorative):
 * emerald = settled/success, amber = in-flight/warning, red = error, slate = idle/absent.
 * Previously copy-pasted as a private `StatusBadge` in ImagesView, IsolationsView, and inline in
 * several row components.
 */
export type Tone = 'ok' | 'busy' | 'error' | 'idle' | 'accent';

const TONES: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  busy: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  error: 'border-red-500/30 bg-red-500/10 text-red-400',
  idle: 'border-white/[0.08] bg-white/[0.04] text-slate-500',
  accent: 'border-accent/30 bg-accent/10 text-accent',
};

const DOT_TONES: Record<Tone, string> = {
  ok: 'bg-emerald-400',
  busy: 'bg-amber-400',
  error: 'bg-red-400',
  idle: 'bg-slate-600',
  accent: 'bg-accent',
};

/** Map the backend's docker/image/build status strings onto the tone vocabulary. */
export function toneOf(status: string): Tone {
  switch (status) {
    case 'built':
    case 'done':
    case 'running':
      return 'ok';
    case 'building':
    case 'queued':
      return 'busy';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

export function StatusBadge({
  tone,
  children,
  className = '',
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** A tiny state dot — `pulse` marks liveness only (DIRECT_ART §6: never animate something idle). */
export function Dot({ tone, title, pulse }: { tone: Tone; title?: string; pulse?: boolean }) {
  return (
    <span
      title={title}
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONES[tone]} ${pulse ? 'animate-pulse' : ''}`}
    />
  );
}

/** Neutral metadata chip: a key/value or a lone token in a white-alpha well. */
export function Chip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-400 ${className}`}
    >
      {children}
    </span>
  );
}

/** Label + value pill used in summary bars (mirrors ScoringView's `Pill`). */
export function Pill({ label, value, tone }: { label: string; value: string; tone?: 'accent' }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
        tone === 'accent'
          ? 'border-accent/25 bg-accent/10 text-accent'
          : 'border-white/[0.07] bg-white/[0.03] text-slate-400'
      }`}
    >
      <span className="uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-mono text-slate-100">{value}</span>
    </span>
  );
}
