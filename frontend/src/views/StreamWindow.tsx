import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Radio } from 'lucide-react';
import { LiveStreamPlayer } from '../components/stream/LiveStreamPlayer';

/**
 * The streaming page: one flux, full window, nothing else (STREAMING_PLAN.md §5).
 *
 * Mounted at `/stream/:flowId` *outside* the app layout — no sidebar, no header, no navigation —
 * and opened with `window.open` from the header badge, the same pattern as `/desktop/:agentId`. A
 * stream is something you leave running on a second monitor, so the page is deliberately not part of
 * the command center's navigation: closing it stops nothing, and the app behind it is untouched.
 *
 * It mounts its own `.space-bg` because it is not under `MainLayout`, which is the one place that
 * normally owns the backdrop (DIRECT_ART §1).
 */
export function StreamWindow() {
  const { flowId = '' } = useParams();
  const [params] = useSearchParams();
  const [gone, setGone] = useState(false);
  const name = params.get('name') || 'Stream';

  useEffect(() => {
    document.title = `${name} · Live`;
  }, [name]);

  return (
    <div className="space-bg flex h-screen w-screen flex-col">
      <header className="glass flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <Radio size={14} className="text-slate-400" />
        <span className="text-xs font-semibold tracking-wide text-slate-200">{name}</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.18em] text-slate-600">
          PleiadesAI · live
        </span>
      </header>
      <main className="min-h-0 flex-1">
        {gone ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-sm text-slate-300">This stream is off the air.</p>
            <button
              onClick={() => window.close()}
              className="rounded-lg px-3 py-1.5 text-xs text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-slate-200"
            >
              Close window
            </button>
          </div>
        ) : (
          <LiveStreamPlayer flowId={flowId} onStopped={() => setGone(true)} />
        )}
      </main>
    </div>
  );
}
