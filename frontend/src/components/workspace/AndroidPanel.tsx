import { useEffect, useRef } from 'react';
import {
  Smartphone,
  Hand,
  Eye,
  X,
  RefreshCw,
  AlertTriangle,
  Loader2,
  ExternalLink,
  ChevronLeft,
  Circle,
  Square,
  ClipboardPaste,
  Volume2,
  VolumeX,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { useAndroidMirror, type MirrorStatus } from './useAndroidMirror';

/** Open the chrome-free phone route in a separate browser window (same origin → shares auth). */
export function openPhoneWindow(agentId: string, agentName: string) {
  const url = `${window.location.origin}/phone/${agentId}?name=${encodeURIComponent(agentName)}`;
  // A stable per-agent window name so re-opening focuses the existing window instead of duplicating.
  window.open(url, `pleiades-phone-${agentId}`, 'width=520,height=980');
}

type Mirror = ReturnType<typeof useAndroidMirror>;

/**
 * The mirror itself: canvas, overlays and the Android navigation bar. Shared verbatim by the inline
 * modal (`AndroidPanel`) and the popped-out window (`AndroidPhoneWindow`) so the two can never drift
 * — the only thing that differs between them is the chrome around this.
 */
export function AndroidScreen({ mirror }: { mirror: Mirror }) {
  const { canvasRef, status, error, takeover, reconnect, pressNav, rotate, handlers } = mirror;
  const stageRef = useRef<HTMLDivElement>(null);

  // The canvas can't take focus on its own, so keystrokes are captured on the stage. Focusing it as
  // soon as the operator takes control means they can just start typing.
  useEffect(() => {
    if (takeover) stageRef.current?.focus();
  }, [takeover]);

  return (
    <>
      <div
        ref={stageRef}
        tabIndex={-1}
        onKeyDown={handlers.onKeyDown}
        className="relative min-h-0 flex-1 bg-[#0b0f19] outline-none"
      >
        <canvas
          ref={canvasRef}
          onPointerDown={handlers.onPointerDown}
          onPointerMove={handlers.onPointerMove}
          onPointerUp={handlers.onPointerUp}
          onPointerCancel={handlers.onPointerUp}
          onWheel={handlers.onWheel}
          className={[
            'absolute inset-0 h-full w-full object-contain',
            takeover ? 'cursor-crosshair touch-none' : 'pointer-events-none',
          ].join(' ')}
        />

        {status === 'connecting' && (
          <Overlay>
            <Loader2 size={22} className="animate-spin text-reasoning" />
            <p className="text-sm text-slate-300">Starting the mirror…</p>
          </Overlay>
        )}
        {(status === 'error' || status === 'closed') && (
          <Overlay>
            <AlertTriangle size={22} className={status === 'error' ? 'text-amber-400' : 'text-slate-400'} />
            <p className="max-w-md text-center text-sm text-slate-300">
              {error || (status === 'closed' ? 'The mirror session ended.' : 'Something went wrong.')}
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

      {/* Android's own navigation bar. An emulator often runs without one, and even when it has one
          the gesture equivalents are awkward with a mouse — so these are always offered. */}
      <div className="flex items-center justify-center gap-6 border-t border-slate-800 bg-panel py-2">
        <NavButton
          label="Back"
          disabled={!takeover || status !== 'streaming'}
          onClick={() => pressNav('back')}
        >
          <ChevronLeft size={18} />
        </NavButton>
        <NavButton
          label="Home"
          disabled={!takeover || status !== 'streaming'}
          onClick={() => pressNav('home')}
        >
          <Circle size={14} />
        </NavButton>
        <NavButton
          label="Recent apps"
          disabled={!takeover || status !== 'streaming'}
          onClick={() => pressNav('app_switch')}
        >
          <Square size={13} />
        </NavButton>

        {/* Rotation. Separated from the navigation keys because it changes the device's state rather
            than navigating it, and gated on takeover for the same reason android_act is: turning the
            screen under a working agent would invalidate every coordinate it just read. */}
        <span className="mx-1 h-4 w-px bg-slate-700" aria-hidden />
        <NavButton
          label="Rotate left"
          disabled={!takeover || status !== 'streaming'}
          onClick={() => rotate(-1)}
        >
          <RotateCcw size={15} />
        </NavButton>
        <NavButton
          label="Rotate right"
          disabled={!takeover || status !== 'streaming'}
          onClick={() => rotate(1)}
        >
          <RotateCw size={15} />
        </NavButton>
      </div>
    </>
  );
}

/** The header controls shared by both shells: take/release control and paste text. */
export function MirrorControls({ mirror }: { mirror: Mirror }) {
  const { status, takeover, setTakeover, sendText, audio, toggleAudio, info } = mirror;
  const live = status === 'streaming';
  // Show the control as soon as the session is up, even when the device has audio switched off:
  // hiding it entirely leaves the operator with no way to discover the feature exists, which is
  // exactly how it reads as "there is no sound support" rather than "sound is off for this device".
  const audioOff = Boolean(info && !info.hasAudio);

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendText(text);
    } catch {
      // Clipboard permission denied (or an insecure origin) — fall back to asking for the text.
      const text = window.prompt('Text to type on the device:');
      if (text) sendText(text);
    }
  };

  return (
    <>
      <button
        onClick={() => setTakeover(!takeover)}
        disabled={!live}
        title={takeover ? 'Release control (view only)' : 'Take control (touch & keyboard)'}
        className={[
          'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40',
          takeover
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
        ].join(' ')}
      >
        {takeover ? <Hand size={14} /> : <Eye size={14} />}
        {takeover ? 'Controlling' : 'View only'}
      </button>
      {/* Audio is only offered once the device has announced a stream this browser can decode. The
          button is the required user gesture — browsers will not start an AudioContext without one. */}
      {(audio.available || audio.reason || audioOff) && (
        <button
          onClick={toggleAudio}
          disabled={!audio.available}
          title={
            audioOff
              ? 'Audio forwarding is switched off for this device — turn it on in Settings → Connections, then reopen this panel.'
              : (audio.reason ??
                (audio.playing ? 'Mute the device audio' : 'Play the device audio'))
          }
          className={[
            'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors disabled:opacity-40',
            audio.playing
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200',
          ].join(' ')}
        >
          {audio.playing ? <Volume2 size={14} /> : <VolumeX size={14} />}
          {audio.playing ? 'Audio' : 'Muted'}
        </button>
      )}
      <button
        onClick={paste}
        disabled={!live || !takeover}
        title="Type the clipboard's contents into the focused field"
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-40"
      >
        <ClipboardPaste size={14} /> Paste
      </button>
    </>
  );
}

interface Props {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

/**
 * Live Android mirror for an agent, shown as an inline modal — the phone counterpart of
 * `VisualPanel`. Connection and decoding are handled by `useAndroidMirror`; this is the modal chrome.
 * "Open in window" pops the same mirror out into a standalone browser window (`/phone/:agentId`).
 *
 * The modal is deliberately narrow: a phone screen is portrait, and stretching it to the desktop
 * panel's width would leave two thirds of the dialog as empty letterbox.
 */
export function AndroidPanel({ agentId, agentName, onClose }: Props) {
  const mirror = useAndroidMirror(agentId);
  const { status, takeover, info } = mirror;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-lg border border-slate-700 bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
          <Smartphone size={15} className="text-reasoning" />
          <span className="truncate text-sm font-medium text-slate-200">{agentName} · Phone</span>
          <StatusPill status={status} />

          <div className="ml-auto flex items-center gap-1.5">
            <MirrorControls mirror={mirror} />
            <button
              onClick={() => {
                openPhoneWindow(agentId, agentName);
                onClose();
              }}
              title="Open the phone in a separate window"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <ExternalLink size={15} />
            </button>
            <button
              onClick={onClose}
              title="Close mirror"
              className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex min-h-[60vh] flex-col">
          <AndroidScreen mirror={mirror} />
        </div>

        <div className="border-t border-slate-700 px-3 py-1.5 text-[11px] text-slate-500">
          {takeover
            ? 'You are driving. Taps and keystrokes go to the device — the agent’s android_act stands down until you release.'
            : info
              ? `View only — watching ${info.device || info.deviceName} at ${info.width}×${info.height}. Take control to intervene.`
              : 'View only — watching the agent. Take control to intervene.'}
        </div>
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: MirrorStatus }) {
  const map: Record<MirrorStatus, { label: string; cls: string }> = {
    connecting: { label: 'Connecting', cls: 'bg-slate-700/60 text-slate-300' },
    streaming: { label: 'Live', cls: 'bg-emerald-500/15 text-emerald-400' },
    error: { label: 'Error', cls: 'bg-amber-500/15 text-amber-400' },
    closed: { label: 'Ended', cls: 'bg-slate-700/60 text-slate-400' },
  };
  const { label, cls } = map[status];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
}

function NavButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-md p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0f19]/80 backdrop-blur-sm">
      {children}
    </div>
  );
}
