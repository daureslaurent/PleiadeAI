import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { visualApi } from '../../lib/api';

export type VisualStatus = 'connecting' | 'connected' | 'error' | 'closed';

/** Pull the backend's `{ message }` out of an axios error, else a sensible fallback. */
function extractMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
  if (data?.message) return data.message;
  return err instanceof Error ? err.message : 'Failed to open the desktop.';
}

/**
 * Shared live-desktop connection for the Visual skill: runs the handshake
 * (`POST …/container/visual/session`), opens the raw-binary WebSocket relay, and mounts a noVNC RFB
 * client on `screenRef`. Starts **view-only**; `setTakeover(true)` flips `rfb.viewOnly` and tells the
 * backend so the agent's `visual_act` pauses while the human drives. Used by both the inline modal
 * (`VisualPanel`) and the popped-out window (`VisualDesktopWindow`).
 */
export function useVisualDesktop(agentId: string) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<VisualStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Keep input-gating in sync with the takeover toggle, and tell the backend so the agent's
  // `visual_act` pauses while the human drives (best-effort).
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !takeover;
    visualApi.control(agentId, takeover).catch(() => undefined);
  }, [takeover, agentId]);

  // Always release manual control when the consumer unmounts.
  useEffect(() => () => void visualApi.control(agentId, false).catch(() => undefined), [agentId]);

  // (Re)connect on agent change or manual retry. The screen div stays mounted so RFB always has a
  // target; connection state is surfaced as `status`/`error` for the consumer to overlay.
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

  return {
    screenRef,
    status,
    error,
    takeover,
    setTakeover,
    reconnect: () => setAttempt((a) => a + 1),
    sendCtrlAltDel: () => rfbRef.current?.sendCtrlAltDel(),
  };
}
