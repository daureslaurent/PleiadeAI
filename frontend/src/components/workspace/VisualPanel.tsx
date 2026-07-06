import { Monitor, Hand, Eye, X, RefreshCw, AlertTriangle, Loader2, Keyboard, ExternalLink } from 'lucide-react';
import { useVisualDesktop, type VisualStatus } from './useVisualDesktop';

interface Props {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

/** Open the chrome-free desktop route in a separate browser window (same origin → shares auth). */
export function openDesktopWindow(agentId: string, agentName: string) {
  const url = `${window.location.origin}/desktop/${agentId}?name=${encodeURIComponent(agentName)}`;
  // A stable per-agent window name so re-opening focuses the existing window instead of duplicating.
  window.open(url, `pleiade-desktop-${agentId}`, 'width=1320,height=880');
}

/**
 * Live visual desktop for an isolated agent (Visual skill), shown as an inline modal. Connection is
 * handled by `useVisualDesktop`; this component is the modal chrome (header controls + overlays).
 * "Open in window" pops the same desktop out into a standalone browser window (`/desktop/:agentId`).
 */
export function VisualPanel({ agentId, agentName, onClose }: Props) {
  const { screenRef, status, error, takeover, setTakeover, reconnect, sendCtrlAltDel } =
    useVisualDesktop(agentId);

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
              onClick={() => setTakeover(!takeover)}
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
              onClick={sendCtrlAltDel}
              disabled={status !== 'connected' || !takeover}
              title="Send Ctrl+Alt+Del"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
            >
              <Keyboard size={14} /> Ctrl+Alt+Del
            </button>
            <button
              onClick={() => {
                openDesktopWindow(agentId, agentName);
                onClose();
              }}
              title="Open the desktop in a separate window"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <ExternalLink size={14} /> Open in window
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
                onClick={reconnect}
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

function StatusPill({ status }: { status: VisualStatus }) {
  const map: Record<VisualStatus, { label: string; cls: string }> = {
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
