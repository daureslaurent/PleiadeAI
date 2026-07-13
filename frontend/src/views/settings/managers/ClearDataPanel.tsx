import { useEffect, useState } from 'react';
import { Check, Eraser, ShieldAlert } from 'lucide-react';
import { Button, Callout, Checkbox, Input } from '../../../components/ui';
import { maintenanceApi, type ClearSummary, type DataCounts, type ResetCategory } from '../../../lib/api';
import { downloadBlob } from './BackupTransfer';

/** Human labels for the raw collection keys returned by GET /maintenance/data-counts. */
const CLEAR_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  messages: 'Messages',
  scores: 'Scores',
  llama_calls_debug: 'Inference logs (recent)',
  llama_calls_archive: 'Inference logs (archive)',
  notifications: 'Notifications',
  autonomy_run_results: 'Autonomy run history',
  finetune_jobs: 'Fine-tune job history',
};

const CLEAR_CATEGORIES: ResetCategory[] = ['conversations', 'scores', 'logs', 'activity'];

function flattenCounts(counts: DataCounts): { key: string; label: string; count: number }[] {
  const rows: { key: string; label: string; count: number }[] = [];
  for (const category of CLEAR_CATEGORIES) {
    for (const [key, count] of Object.entries(counts[category] ?? {})) {
      rows.push({ key, label: CLEAR_LABELS[key] ?? key, count });
    }
  }
  return rows;
}

/**
 * "Clear all data" — wipes conversations, scores, inference logs and activity records, keeping the
 * fleet (agents/isolations/images) and memory. Guarded by a type-CLEAR modal that first shows the
 * exact row counts, with an opt-in JSON backup downloaded before the wipe.
 *
 * This one keeps its bespoke modal rather than `useConfirm` — the shared dialog has no room for the
 * row table, the backup opt-in and the typed confirmation.
 */
export function ClearDataPanel() {
  const [counts, setCounts] = useState<DataCounts | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [backup, setBackup] = useState(true);
  const [busy, setBusy] = useState<null | 'backup' | 'clear'>(null);
  const [result, setResult] = useState<ClearSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    maintenanceApi.counts().then(setCounts).catch(() => setError('Failed to load data counts.'));
  useEffect(() => {
    void reload();
  }, []);

  const rows = counts ? flattenCounts(counts) : [];
  const total = rows.reduce((n, r) => n + r.count, 0);

  function close() {
    setOpen(false);
    setConfirmText('');
    setError(null);
  }

  async function doClear() {
    if (confirmText !== 'CLEAR') return;
    setError(null);
    try {
      if (backup) {
        setBusy('backup');
        const blob = await maintenanceApi.exportBlob(CLEAR_CATEGORIES);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        downloadBlob(blob, `pleiades-data-backup-${stamp}.json`);
      }
      setBusy('clear');
      const summary = await maintenanceApi.clear(CLEAR_CATEGORIES);
      setResult(summary);
      close();
      await reload();
    } catch {
      setError('Clear failed — see server logs.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-slate-500">
          Deletes all conversations, scores, inference logs and activity records
          {total > 0 && <span className="text-slate-400"> ({total.toLocaleString()} rows)</span>}. Agents,
          isolations, images and memory are kept. This cannot be undone.
        </p>
        <Button
          variant="danger"
          icon={<Eraser size={14} />}
          onClick={() => {
            setResult(null);
            setOpen(true);
          }}
        >
          Clear all data
        </Button>
      </div>

      {result && (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <Check size={14} /> Cleared {result.total.toLocaleString()} rows.
        </p>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Clear all data"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div className="glass-card w-full max-w-md animate-fade-up space-y-4 rounded-2xl border border-red-500/25 p-5">
            <div className="flex items-center gap-2 text-red-400">
              <ShieldAlert size={18} />
              <h3 className="text-sm font-semibold text-slate-100">Clear all data?</h3>
            </div>

            <p className="text-xs text-slate-400">
              This permanently deletes the following. Agents, isolations, images and memory are kept.
            </p>

            <div className="max-h-52 divide-y divide-white/[0.06] overflow-auto rounded-xl border border-white/[0.06] bg-black/25">
              {rows.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-slate-500">Nothing to clear.</div>
              ) : (
                rows.map((r) => (
                  <div key={r.key} className="flex justify-between px-3 py-1.5 text-xs">
                    <span className="text-slate-300">{r.label}</span>
                    <span className="font-mono text-slate-400">{r.count.toLocaleString()}</span>
                  </div>
                ))
              )}
            </div>

            <Checkbox checked={backup} onChange={setBackup}>
              Download a JSON backup first
            </Checkbox>

            <div>
              <div className="mb-1.5 text-[11px] text-slate-400">
                Type <span className="font-mono font-semibold text-red-300">CLEAR</span> to confirm
              </div>
              <Input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void doClear()}
                placeholder="CLEAR"
                className="focus:border-red-500/60"
              />
            </div>

            {error && <Callout tone="error">{error}</Callout>}

            <div className="flex justify-end gap-2">
              <Button onClick={close} disabled={busy !== null}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void doClear()}
                disabled={confirmText !== 'CLEAR'}
                loading={busy !== null}
              >
                {busy === 'backup' ? 'Backing up…' : busy === 'clear' ? 'Clearing…' : 'Clear data'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
