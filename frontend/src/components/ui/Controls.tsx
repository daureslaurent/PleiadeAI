import { forwardRef } from 'react';
import type {
  ReactNode,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
} from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Form controls on glass (DIRECT_ART §2): inputs are inset *wells* (`bg-black/25`) with white-alpha
 * hairlines that resolve to accent on focus — never the legacy `border`/`panel` greys, which read as
 * opaque patches on a translucent panel.
 */
const WELL =
  'w-full rounded-lg border border-white/[0.07] bg-black/25 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition-colors focus:border-accent/60 focus:bg-black/30';

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${WELL} ${className}`} />;
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} spellCheck={false} className={`${WELL} font-mono text-[11px] leading-relaxed ${className}`} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  // `bg-panel` on the <option>s: native dropdown popups can't be glass, so give them the legacy
  // opaque ground rather than an unreadable translucent one.
  return (
    <select {...props} className={`${WELL} cursor-pointer [&>option]:bg-panel ${className}`}>
      {children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{children}</div>
  );
}

/** Label + control + optional hint, stacked. */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <Label>{label}</Label>
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-slate-500">{hint}</span>}
    </label>
  );
}

/** Switch. Accent when on; a neutral white-alpha well when off. */
export function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-white/[0.06] ring-1 ring-inset ring-white/[0.12]'
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/** Checkbox styled for glass — a small accent-filled well when checked. */
export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer rounded border-white/20 bg-black/30 accent-accent"
      />
      {children}
    </label>
  );
}

type Variant = 'primary' | 'ghost' | 'danger' | 'accentSoft';

const VARIANTS: Record<Variant, string> = {
  // The one loud element per surface: solid accent.
  primary: 'bg-accent text-white hover:bg-accent/90 active:scale-95',
  // Quiet default: white-alpha ring, fills on hover.
  ghost: 'text-slate-300 ring-1 ring-white/[0.1] hover:bg-white/[0.06] active:scale-95',
  // Destructive: red alpha, never a solid red block.
  danger: 'text-red-400 ring-1 ring-red-500/30 hover:bg-red-500/10 active:scale-95',
  // Secondary action that still belongs to the accent (e.g. Build, Score now).
  accentSoft: 'bg-accent/20 text-accent ring-1 ring-accent/40 hover:bg-accent/30 active:scale-95',
};

export type ButtonProps = {
  variant?: Variant;
  loading?: boolean;
  icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/** `forwardRef` so callers can focus it (the confirm dialog autofocuses its affirmative button). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', loading, icon, children, className = '', ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      disabled={props.disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

/** Centered spinner for a pane that is still loading. */
export function Spinner() {
  return (
    <div className="flex h-full min-h-[8rem] items-center justify-center text-slate-500">
      <Loader2 className="animate-spin" />
    </div>
  );
}
