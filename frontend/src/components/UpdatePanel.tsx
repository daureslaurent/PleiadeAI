import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react';
import { hostApi, type UpdateInfo } from '../lib/api';
import { Button } from './ui/Controls';
import { APP_VERSION } from '../version';

/**
 * Update actions + status. Reads the host bridge directly, independently of the settings doc that
 * owns the enable toggle + interval. Shows the deployed version, a "Check now" button, the commits
 * the tracked branch is ahead, and an "Update app" button that triggers the host rebuild and hands
 * off to `UpdateOverlay`, which tails the log until the rebuilt stack answers again — then reloads
 * onto it.
 *
 * `enabled` mirrors the toggle on the System settings page, which autosaves; the button reflects the
 * operator's intent as soon as it's flipped, and the backend still enforces the persisted setting.
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
              ? 'Turn on "Enable app updates" first'
              : behind === 0
                ? 'No update available'
                : 'Pull latest and rebuild the stack'
          }
          className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          <Download size={15} /> Update app
        </button>
        {!enabled && (
          <span className="text-xs text-slate-500">Turn on “Enable app updates” to unlock.</span>
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

/** The steps `update_run.sh` prints, in order. The log markers are how we follow it from here. */
const STEPS = [
  { key: 'pull', label: 'Pull', marker: '==> Updating' },
  { key: 'build', label: 'Build', marker: '==> Building' },
  { key: 'swap', label: 'Swap', marker: '==> Swapping' },
] as const;

/** `update_run.sh` prints this once the swap succeeded and it's dumping `docker compose ps`. */
const DONE_MARKER = '==> Done.';

/** No log growth for this long, with the backend answering, means the host run died mid-flight. */
const STALL_MS = 5 * 60_000;

/**
 * Is the stack serving? Caddy proxies `/health` to the backend and *stays up across the swap*, so a
 * downed backend comes back as a 502 **response**, not a network error — a non-ok status has to
 * count as "down" just like a throw does, or the outage is never seen. The SPA root is probed too:
 * the frontend container is recreated as well, and reloading before nginx is back lands the operator
 * on a browser error page.
 */
async function probeUp(): Promise<boolean> {
  const ok = async (url: string, method: string) => {
    try {
      const res = await fetch(url, { method, cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  };
  return (await ok('/health', 'GET')) && (await ok('/', 'HEAD'));
}

/**
 * Full-screen "Updating…" window. Triggers the host update, tails the log from the offset captured
 * at trigger time, and reloads onto the new build once the rebuilt stack answers again.
 *
 * "Finished" is two independent signals, because either one alone misses a real case: an **outage**
 * on the health probe (the container swap) covers a backend rebuild, and the log's `Done` **marker**
 * covers an update that never takes the backend down (a frontend-only change, or a no-op rebuild) —
 * which would otherwise tail forever. Either one, once the stack probes healthy again, means reload.
 */
function UpdateOverlay({ onClose }: { onClose: () => void }) {
  const [logText, setLogText] = useState('');
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // React 18 StrictMode double-invoke guard
    startedRef.current = true;

    let cancelled = false;
    let offset = 0;
    let log = '';
    let sawOutage = false;
    let lastGrowth = Date.now();

    async function tailUntilBack() {
      while (!cancelled) {
        try {
          const chunk = await hostApi.updateLog(offset);
          if (chunk.text) {
            offset = chunk.offset;
            log += chunk.text;
            lastGrowth = Date.now();
            setLogText(log);
          }
        } catch {
          // Backend momentarily gone during the swap — expected; the health probe is the authority.
        }

        const up = await probeUp();
        const done = log.includes(DONE_MARKER);

        if (!up) {
          sawOutage = true; // the swap is under way
          setPhase('waiting');
        } else if (sawOutage || done) {
          setPhase('done');
          await sleep(600); // let the operator see it landed before the page goes
          window.location.reload();
          return;
        } else {
          // Still building on the old stack. A long-silent log with a healthy backend means the
          // host run died (`set -e`) — say so instead of spinning forever.
          setPhase(Date.now() - lastGrowth > STALL_MS ? 'stalled' : 'running');
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

  const live = phase !== 'error' && phase !== 'stalled' && phase !== 'done';
  const dismissable = phase === 'error' || phase === 'stalled';
  const step = currentStep(logText, phase);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Updating PleiadesAI"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="glass-card flex max-h-[80vh] w-full max-w-2xl animate-fade-up flex-col rounded-2xl border border-white/[0.09]">
        {/* Header: a live status dot that breathes in the phase's colour, per DIRECT_ART §6. */}
        <header className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3.5">
          <StatusDot phase={phase} />
          <h2 className={`text-sm font-semibold text-slate-100 ${live ? 'text-shimmer' : ''}`}>
            {HEADLINE[phase]}
          </h2>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wide text-slate-500">
            v{APP_VERSION}
          </span>
        </header>

        {/* Stepper: pull → build → swap → back online, read off the host script's own log markers. */}
        <div className="flex items-center gap-1.5 px-5 py-3">
          {[...STEPS.map((s) => s.label), 'Back online'].map((label, i) => (
            <Step key={label} label={label} state={i < step ? 'done' : i === step ? 'active' : 'todo'} />
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden px-5 pb-4">
          {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
          {phase === 'stalled' && (
            <p className="mb-2 flex items-start gap-1.5 text-xs text-amber-400">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              No output for {Math.round(STALL_MS / 60_000)} minutes and the stack is still serving the
              old build — the host update likely failed. Check{' '}
              <code className="rounded bg-black/30 px-1 font-mono">journalctl -u pleiades-update</code>.
            </p>
          )}
          {/* Machine output → inset terminal well (DIRECT_ART §2, §7). */}
          <pre
            ref={preRef}
            className="h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-slate-300"
          >
            {logText || 'Starting…'}
          </pre>
          {live && (
            <p className="mt-2.5 text-[11px] text-slate-500">
              The page reloads itself once the rebuilt stack is back online. Don't close this tab.
            </p>
          )}
        </div>

        {dismissable && (
          <footer className="flex justify-end gap-2 border-t border-white/[0.06] px-5 py-3">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {phase === 'stalled' && (
              <Button variant="primary" icon={<RefreshCw size={13} />} onClick={() => window.location.reload()}>
                Reload anyway
              </Button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

type Phase = 'starting' | 'running' | 'waiting' | 'done' | 'stalled' | 'error';

const HEADLINE: Record<Phase, string> = {
  starting: 'Starting the update…',
  running: 'Updating PleiadesAI…',
  waiting: 'Swapping containers — waiting for the stack…',
  done: 'Updated. Reloading…',
  stalled: 'Update may have failed',
  error: 'Update failed',
};

/** Index into [pull, build, swap, back online] — which step the log says we're on. */
function currentStep(log: string, phase: Phase): number {
  if (phase === 'done') return 4;
  if (phase === 'waiting' || log.includes(DONE_MARKER)) return 3;
  const reached = STEPS.filter((s) => log.includes(s.marker)).length;
  return Math.max(0, reached - 1);
}

/** Liveness in one glyph: a colour-coded dot that breathes while the update is actually moving. */
function StatusDot({ phase }: { phase: Phase }) {
  if (phase === 'error') return <AlertTriangle size={16} className="shrink-0 text-red-400" />;
  if (phase === 'stalled') return <AlertTriangle size={16} className="shrink-0 text-amber-400" />;
  if (phase === 'done') return <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />;
  const color = phase === 'waiting' ? '#f59e0b' : '#3b82f6';
  return (
    <span
      className="h-2 w-2 shrink-0 animate-glow-pulse rounded-full"
      style={{ background: color, ['--glow' as string]: `${color}59` }}
    />
  );
}

function Step({ label, state }: { label: string; state: 'done' | 'active' | 'todo' }) {
  const style =
    state === 'done'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400/90'
      : state === 'active'
        ? 'border-accent/40 bg-accent/15 text-accent'
        : 'border-white/[0.06] bg-white/[0.03] text-slate-600';
  return (
    <span
      className={`flex-1 rounded-full border px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide transition-colors ${style}`}
    >
      {label}
    </span>
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errText(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return msg || fallback;
}
