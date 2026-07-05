import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react';
import { hostApi, type UpdateInfo } from '../lib/api';
import { APP_VERSION } from '../version';

/**
 * Update actions + status. Reads the host bridge directly (independent of the Settings
 * "Save" flow, which owns the enable toggle + interval). Shows the deployed version, a
 * "Check now" button, the commits the tracked branch is ahead, and an "Update app" button
 * that triggers the host rebuild and tails the log in a full-screen overlay until the
 * rebuilt stack answers again — then reloads.
 *
 * `enabled` mirrors the (possibly unsaved) toggle in the parent so the update button reflects
 * the operator's intent immediately; the backend still enforces the persisted setting.
 */
export function UpdatePanel({ enabled }: { enabled: boolean }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    hostApi.getUpdate().then(setInfo).catch(() => setInfo(null));
  }, []);

  async function checkNow() {
    setChecking(true);
    setError(null);
    try {
      setInfo(await hostApi.checkUpdate());
    } catch (e) {
      setError(errText(e, 'Check failed. Is the host update watcher installed?'));
    } finally {
      setChecking(false);
    }
  }

  const status = info?.status ?? null;
  const behind = status?.behindBy ?? 0;
  const bridgeReady = info?.ready ?? false;

  return (
    <div className="space-y-4">
      {/* Deployed version + last check */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-panel px-3 py-2 text-xs text-slate-400">
        <span>
          Version <span className="font-mono text-slate-200">v{status?.currentVersion || APP_VERSION}</span>
        </span>
        <span>
          Branch <span className="font-mono text-slate-300">{status?.branch || 'master'}</span>
        </span>
        {status?.currentShortSha && (
          <span>
            Commit <span className="font-mono text-slate-300">{status.currentShortSha}</span>
          </span>
        )}
        {status?.checkedAt && (
          <span className="ml-auto text-slate-500">Checked {new Date(status.checkedAt).toLocaleString()}</span>
        )}
      </div>

      {/* Bridge-not-ready hint */}
      {info && !bridgeReady && (
        <div className="flex items-start gap-1.5 text-xs text-amber-400/80">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Host update bridge not ready{info.reason ? `: ${info.reason}` : ''}. Install it with{' '}
            <code className="rounded bg-panel px-1">sudo tools/updater/install-updater.sh</code>.
          </span>
        </div>
      )}

      {/* Status line */}
      {status?.error ? (
        <div className="flex items-start gap-1.5 text-xs text-red-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {status.error}
        </div>
      ) : behind > 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-amber-400">
          <Download size={13} /> {behind} update{behind === 1 ? '' : 's'} available
          {status?.remoteVersion && status.remoteVersion !== status.currentVersion && (
            <span className="text-slate-400">
              {' '}
              (v{status.currentVersion} → v{status.remoteVersion})
            </span>
          )}
        </div>
      ) : status ? (
        <div className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 size={13} /> Up to date
        </div>
      ) : null}

      {/* Commits ahead */}
      {behind > 0 && status && (
        <ul className="max-h-56 space-y-1 overflow-auto rounded-md border border-border bg-panel p-2">
          {status.commits.map((c) => (
            <li key={c.sha} className="flex items-start gap-2 rounded px-1.5 py-1 text-xs">
              <GitCommitHorizontal size={13} className="mt-0.5 shrink-0 text-slate-500" />
              <div className="min-w-0">
                <div className="truncate text-slate-200">{c.subject}</div>
                <div className="text-[10px] text-slate-500">
                  <span className="font-mono">{c.shortSha}</span> · {c.author}
                  {c.date ? ` · ${new Date(c.date).toLocaleDateString()}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={checkNow}
          disabled={checking || !bridgeReady}
          className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm text-slate-200 hover:bg-surface disabled:opacity-50"
        >
          {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Check now
        </button>
        <button
          onClick={() => setUpdating(true)}
          disabled={!enabled || !bridgeReady || behind === 0}
          title={
            !enabled
              ? 'Enable app updates and Save first'
              : behind === 0
                ? 'No update available'
                : 'Pull latest and rebuild the stack'
          }
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <Download size={15} /> Update app
        </button>
        {!enabled && (
          <span className="text-xs text-slate-500">Enable app updates and Save to unlock.</span>
        )}
      </div>

      {updating && (
        <UpdateOverlay
          onClose={() => setUpdating(false)}
        />
      )}
    </div>
  );
}

/**
 * Full-screen "Updating…" overlay. Triggers the host update, tails the log from the offset
 * captured at trigger time, and polls /health until the rebuilt stack answers — then reloads
 * the page onto the new build. If the update trigger itself fails, surfaces the error and lets
 * the operator dismiss.
 */
function UpdateOverlay({ onClose }: { onClose: () => void }) {
  const [logText, setLogText] = useState('');
  const [phase, setPhase] = useState<'starting' | 'running' | 'waiting' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // React 18 StrictMode double-invoke guard
    startedRef.current = true;

    let cancelled = false;
    let offset = 0;
    let backOnline = false;

    async function tailUntilBack() {
      // Poll the log + health together. The container swap will drop this request mid-flight;
      // once it answers 200 again we're on the new build → reload.
      while (!cancelled) {
        try {
          const chunk = await hostApi.updateLog(offset);
          if (chunk.text) {
            offset = chunk.offset;
            setLogText((t) => t + chunk.text);
          }
        } catch {
          // Backend momentarily gone during the swap — that's expected.
        }
        // Health probe: a successful response after the swap means we're back.
        try {
          const res = await fetch('/health', { cache: 'no-store' });
          if (res.ok) {
            if (backOnline) {
              window.location.reload();
              return;
            }
            // First OK is the *old* backend still serving; flip to waiting and require a
            // subsequent OK after an outage to confirm the swap completed.
          }
        } catch {
          backOnline = true; // saw an outage → the swap is in progress
          setPhase('waiting');
        }
        await sleep(1500);
      }
    }

    (async () => {
      try {
        const { logOffset } = await hostApi.runUpdate();
        offset = logOffset;
        setPhase('running');
        void tailUntilBack();
      } catch (e) {
        setPhase('error');
        setError(errText(e, 'Failed to start the update.'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Keep the log scrolled to the bottom as it streams.
    preRef.current?.scrollTo({ top: preRef.current.scrollHeight });
  }, [logText]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-surface shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-3">
          {phase === 'error' ? (
            <AlertTriangle size={16} className="text-red-400" />
          ) : (
            <Loader2 size={16} className="animate-spin text-accent" />
          )}
          <div className="text-sm font-semibold text-slate-100">
            {phase === 'error'
              ? 'Update failed'
              : phase === 'waiting'
                ? 'Rebuilding — waiting for the stack to come back…'
                : 'Updating PleiadeAI…'}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
          <pre
            ref={preRef}
            className="h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel p-3 font-mono text-[11px] leading-relaxed text-slate-300"
          >
            {logText || 'Starting…'}
          </pre>
          <div className="mt-2 text-xs text-slate-500">
            The page reloads automatically once the rebuilt stack is back online. Don't close this tab.
          </div>
        </div>
        {phase === 'error' && (
          <div className="flex justify-end border-t border-border px-5 py-3">
            <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm text-slate-200 hover:bg-panel">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errText(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return msg || fallback;
}
