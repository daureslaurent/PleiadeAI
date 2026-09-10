import { useCallback, useEffect, useState } from 'react';
import { Check, Download, KeyRound, PackagePlus } from 'lucide-react';
import { Button, Callout } from '../../../components/ui';
import { apiSourcesApi, type BuiltinApiInfo } from '../../../lib/api';

/**
 * The shipped catalogue (Settings → APIs).
 *
 * These install themselves at first boot, so this panel exists for the two cases boot can't cover:
 * a preset the operator deleted and now wants back, and the presets a newer release added after this
 * instance had already recorded its first install. Installing never overwrites — an API whose name
 * is already configured is left exactly as the operator edited it.
 */
export function BuiltinApisPicker({ onInstalled }: { onInstalled: () => void }) {
  const [builtins, setBuiltins] = useState<BuiltinApiInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBuiltins(await apiSourcesApi.builtins());
    } catch {
      /* the picker is an extra; the configured list above is what matters */
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const missing = builtins.filter((b) => !b.installed);
  if (!builtins.length) return null;

  async function install() {
    setBusy(true);
    try {
      const { installed } = await apiSourcesApi.installBuiltins();
      setNote(
        installed.length
          ? `Added ${installed.length}: ${installed.join(', ')}.`
          : 'Everything in the catalogue is already configured.',
      );
      await reload();
      onInstalled();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl border border-dashed hairline-strong p-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <PackagePlus size={14} className="shrink-0 text-slate-500" />
        <span className="text-xs text-slate-300">Shipped catalogue</span>
        <span className="text-[11px] text-slate-500">
          {missing.length ? `${missing.length} of ${builtins.length} not configured` : `all ${builtins.length} configured`}
        </span>
        <span className="ml-auto text-[10px] text-slate-500">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <>
          <p className="text-[11px] leading-relaxed text-slate-500">
            These are installed automatically the first time this instance starts. Adding them again only fills in
            what is missing — an API you have edited is never overwritten, and one you deleted stays gone until you
            ask for it here.
          </p>

          <div className="max-h-64 space-y-1 overflow-auto">
            {builtins.map((b) => (
              <div key={b.name} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hairline">
                {b.installed ? (
                  <Check size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                ) : (
                  <Download size={12} className="mt-0.5 shrink-0 text-slate-600" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] text-slate-300">{b.name}</span>
                    <span className="text-[10px] text-slate-600">{b.operations} ops</span>
                    {b.needs_setup && (
                      <span
                        className="flex items-center gap-0.5 text-[10px] text-amber-400"
                        title="Needs your own credential before it can answer."
                      >
                        <KeyRound size={9} /> key
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] leading-snug text-slate-500">{b.description}</p>
                </div>
              </div>
            ))}
          </div>

          {note && <Callout tone="info">{note}</Callout>}

          <Button
            variant="primary"
            onClick={() => void install()}
            loading={busy}
            disabled={!missing.length}
            icon={<Download size={12} />}
          >
            {missing.length ? `Add the ${missing.length} missing` : 'Nothing to add'}
          </Button>
        </>
      )}
    </div>
  );
}
