import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './Controls';

/**
 * Promise-based confirmation dialog, replacing the native `confirm()` calls scattered through the
 * Images / Isolation views (an opaque OS chrome box on a glass command center) and adding the
 * confirmations that were simply missing (Memory Vault delete, Skills delete).
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete image?', body: '…', danger: true }))) return;
 *
 * Error *surfacing* still uses `alert()` — that's a different job and a rarer path.
 */
export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** Label of the affirmative button. Defaults to "Confirm" / "Delete" when `danger`. */
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    setOpts(null);
    resolverRef.current?.(ok);
    resolverRef.current = null;
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && <ConfirmDialog opts={opts} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSettle(false);
      if (e.key === 'Enter') onSettle(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSettle]);

  const affirmative = opts.confirmLabel ?? (opts.danger ? 'Delete' : 'Confirm');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={opts.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onSettle(false)}
    >
      <div className="glass-card w-full max-w-md animate-fade-up rounded-2xl border border-white/[0.09] p-5">
        <div className="flex items-start gap-3">
          {opts.danger && (
            <span className="mt-0.5 shrink-0 text-red-400">
              <AlertTriangle size={18} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-slate-100">{opts.title}</h2>
            {opts.body && (
              <div className="mt-2 whitespace-pre-line text-xs leading-relaxed text-slate-400">
                {opts.body}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onSettle(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            ref={confirmRef}
            variant={opts.danger ? 'danger' : 'primary'}
            onClick={() => onSettle(true)}
          >
            {affirmative}
          </Button>
        </div>
      </div>
    </div>
  );
}
