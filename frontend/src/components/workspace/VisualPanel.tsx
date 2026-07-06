import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { Monitor, Hand, Eye, X, RefreshCw, AlertTriangle, Loader2, Keyboard } from 'lucide-react';
import { visualApi } from '../../lib/api';

type Status = 'connecting' | 'connected' | 'error' | 'closed';

interface Props {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

/** Pull the backend's `{ message }` out of an axios error, else a sensible fallback. */
function extractMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
  if (data?.message) return data.message;
  return err instanceof Error ? err.message : 'Failed to open the desktop.';
}

/**
 * Live visual desktop for an isolated agent (Visual skill). Runs the handshake
 * (`POST …/container/visual/session`), opens the raw-binary WebSocket relay, and mounts a noVNC RFB
 * client on it. Starts **view-only** (watch the agent work); the takeover toggle flips
 * `rfb.viewOnly` so the operator can drive mouse/keyboard. See `VISUAL_SKILL_PLAN.md` Phase 3.
 */
export function VisualPanel({ agentId, agentName, onClose }: Props) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Keep the live session's input-gating in sync with the takeover toggle, and tell the backend so
  // the agent's `visual_act` skill pauses while the human drives (best-effort).
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !takeover;
    visualApi.control(agentId, takeover).catch(() => undefined);
  }, [takeover, agentId]);

  // Always release manual control when the panel closes.
  useEffect(() => () => void visualApi.control(agentId, false).catch(() => undefined), [agentId]);

  // (Re)connect on agent change or manual retry. The screen div stays mounted so RFB always has a
  // target; connection state is shown as an overlay on top of it.
  useEffect(() => {
    let disposed = false;
    let rfb: RFB | null = null;
    setStatus('connecting');
    setError(null);

    void (async () => {
      try {
        const { password, ws_path } = await visualApi.session(agentId);
        if (disposed || !screenRef.current) return;
        rfb = new RFB(screenRef.current, visualApi.wsUrl(ws_path), { credentials: { password } });
        rfb.viewOnly = !takeover;
        rfb.scaleViewport = true;
        rfb.background = '#0b0f19';
        rfb.addEventListener('connect', () => {
          if (!disposed) setStatus('connected');
        });
        rfb.addEventListener('disconnect', (e: Event) => {
          if (disposed) return;
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
          setStatus(clean ? 'closed' : 'error');
          if (!clean) setError('Connection to the desktop was lost.');
        });
        rfb.addEventListener('securityfailure', (e: Event) => {
          if (disposed) return;
          const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
          setError(reason || 'VNC authentication failed.');
          setStatus('error');
        });
        rfbRef.current = rfb;
      } catch (err) {
        if (!disposed) {
          setError(extractMessage(err));
          setStatus('error');
        }
      }
    })();

    return () => {
      disposed = true;
      try {
        rfb?.disconnect();
      } catch {
        /* already gone */
      }
      rfbRef.current = null;
    };
    // takeover is applied via the sync effect above, not a reconnect trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, attempt]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-700 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
          <Monitor size={15} className="text-reasoning" />
          <span className="text-sm font-medium text-slate-200">{agentName} · Desktop</span>
          <StatusPill status={status} />

          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setTakeover((t) => !t)}
              disabled={status !== 'connected'}
              title={takeover ? 'Release control (view only)' : 'Take control (mouse & keyboard)'}
              className={[
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40',
                takeover ? 'bg-emerald-500/15 text-emerald-400' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
              ].join(' ')}
            >
              {takeover ? <Hand size={14} /> : <Eye size={14} />}
              {takeover ? 'Controlling' : 'View only'}
            </button>
            <button
              onClick={() => rfbRef.current?.sendCtrlAltDel()}
              disabled={status !== 'connected' || !takeover}
              title="Send Ctrl+Alt+Del"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
            >
              <Keyboard size={14} /> Ctrl+Alt+Del
            </button>
            <button
              onClick={onClose}
              title="Close desktop"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Screen — RFB mounts its canvas here. Always present so it can attach. */}
        <div className="relative min-h-[60vh] flex-1 bg-[#0b0f19]">
          <div ref={screenRef} className="absolute inset-0" />

          {status === 'connecting' && (
            <Overlay>
              <Loader2 size={22} className="animate-spin text-reasoning" />
              <p className="text-sm text-slate-300">Booting the desktop…</p>
            </Overlay>
          )}
          {(status === 'error' || status === 'closed') && (
            <Overlay>
              <AlertTriangle size={22} className={status === 'error' ? 'text-amber-400' : 'text-slate-400'} />
              <p className="max-w-md text-center text-sm text-slate-300">
                {error || (status === 'closed' ? 'The desktop session ended.' : 'Something went wrong.')}
              </p>
              <button
                onClick={() => setAttempt((a) => a + 1)}
                className="flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs text-slate-200 transition-colors hover:bg-slate-700"
              >
                <RefreshCw size={14} /> Reconnect
              </button>
            </Overlay>
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-slate-700 px-3 py-1.5 text-[11px] text-slate-500">
          {takeover
            ? 'You are driving. Clicks and keystrokes go to the agent’s desktop — release to let the agent work.'
            : 'View only — watching the agent. Take control to intervene.'}
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { label: string; cls: string }> = {
    connecting: { label: 'Connecting', cls: 'bg-slate-700/60 text-slate-300' },
    connected: { label: 'Live', cls: 'bg-emerald-500/15 text-emerald-400' },
    error: { label: 'Error', cls: 'bg-amber-500/15 text-amber-400' },
    closed: { label: 'Ended', cls: 'bg-slate-700/60 text-slate-400' },
  };
  const { label, cls } = map[status];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0f19]/80 backdrop-blur-sm">
      {children}
    </div>
  );
}
