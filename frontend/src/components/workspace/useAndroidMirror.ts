import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react';
import { androidApi } from '../../lib/api';

export type MirrorStatus = 'connecting' | 'streaming' | 'error' | 'closed';

/** Flags in the relay's 9-byte packet header (see `transport/ws/android-proxy.ts`). */
const FLAG_CONFIG = 1;
const FLAG_KEY = 2;

/**
 * Drop non-key frames once the decoder is this far behind. A phone mirror is a *live* view: showing
 * the screen as it is now matters more than showing every frame, and letting the queue grow turns a
 * momentary stall into permanent lag.
 */
const MAX_DECODE_QUEUE = 6;

/** Pull the backend's `{ message }` out of an axios error, else a sensible fallback. */
function extractMessage(err: unknown): string {
  const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
  if (data?.message) return data.message;
  return err instanceof Error ? err.message : 'Failed to open the phone mirror.';
}

/**
 * Derive the WebCodecs codec string from an H.264 SPS, e.g. `avc1.42E01E`. The three bytes after the
 * SPS NAL header are `profile_idc`, the constraint-set flags and `level_idc` — exactly the three the
 * codec string encodes, so reading them is both trivial and exact.
 *
 * Guessing a fixed baseline string instead would work until the device negotiated a different
 * profile (emulators commonly pick high), at which point the decoder would reject the stream.
 */
function codecFromSps(annexB: Uint8Array): string | null {
  for (let i = 0; i + 4 < annexB.length; i += 1) {
    const startCode3 = annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
    const startCode4 =
      annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1;
    if (!startCode3 && !startCode4) continue;
    const nal = i + (startCode4 ? 4 : 3);
    if (nal + 3 >= annexB.length) break;
    if ((annexB[nal]! & 0x1f) !== 7) continue; // not the SPS
    const hex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase();
    return `avc1.${hex(annexB[nal + 1]!)}${hex(annexB[nal + 2]!)}${hex(annexB[nal + 3]!)}`;
  }
  return null;
}

export interface MirrorInfo {
  /** Registry name of the device being mirrored. */
  device: string;
  /** The device's own reported name, e.g. "sdk_gphone64_x86_64". */
  deviceName: string;
  width: number;
  height: number;
}

/**
 * Live Android mirror: the phone counterpart of `useVisualDesktop`, and deliberately the same shape
 * (`screenRef`, `status`, `error`, `takeover`, `reconnect`) so the two panels stay interchangeable
 * to their consumers.
 *
 * The transport underneath is entirely different, because a phone has no VNC server. The backend
 * relays scrcpy's H.264 stream as one binary WS message per access unit; here we feed those into a
 * WebCodecs `VideoDecoder` and paint each decoded frame onto a canvas. Input goes back the other way
 * as small JSON messages which the backend encodes into scrcpy's binary control protocol — so the
 * browser never touches a version-specific byte layout.
 *
 * Starts **view-only**; `setTakeover(true)` starts forwarding input and tells the backend, which
 * drops a lock that makes the agent's `android_act` stand down while the human drives.
 */
export function useAndroidMirror(agentId: string) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<MirrorStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<MirrorInfo | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Read by the pointer/key handlers, which are stable callbacks — a ref keeps them from being
  // rebuilt (and re-bound) on every toggle.
  const takeoverRef = useRef(takeover);
  takeoverRef.current = takeover;

  // Keep the backend's agent-side lock in sync, and always release it on unmount so a closed panel
  // can't leave the agent permanently unable to act.
  useEffect(() => {
    androidApi.control(agentId, takeover).catch(() => undefined);
  }, [takeover, agentId]);
  useEffect(() => () => void androidApi.control(agentId, false).catch(() => undefined), [agentId]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // (Re)connect on agent change or manual retry.
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let decoder: VideoDecoder | null = null;
    let pendingConfig: Uint8Array | null = null;
    let configured = false;

    setStatus('connecting');
    setError(null);
    setInfo(null);

    const fail = (message: string): void => {
      if (disposed) return;
      setError(message);
      setStatus('error');
    };

    if (typeof window.VideoDecoder === 'undefined') {
      fail(
        'This browser has no WebCodecs video decoder, so the phone mirror cannot render. Chrome, Edge and Safari 16.4+ support it; Firefox does not yet.',
      );
      return () => {
        disposed = true;
      };
    }

    const paint = (frame: VideoFrame): void => {
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(frame, 0, 0);
      frame.close();
    };

    void (async () => {
      let wsPath: string;
      try {
        ({ ws_path: wsPath } = await androidApi.session(agentId));
      } catch (err) {
        return fail(extractMessage(err));
      }
      if (disposed) return;

      ws = new WebSocket(androidApi.wsUrl(wsPath));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
        if (disposed) return;

        // Text frames are control-plane: the one-off stream metadata, or a fatal error the relay
        // wants to explain properly (a WS close reason is capped at 123 bytes).
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as Record<string, unknown>;
            if (msg.type === 'meta') {
              setInfo({
                device: String(msg.device ?? ''),
                deviceName: String(msg.deviceName ?? ''),
                width: Number(msg.width) || 0,
                height: Number(msg.height) || 0,
              });
            } else if (msg.type === 'error') {
              fail(String(msg.message ?? 'The phone mirror failed to start.'));
            }
          } catch {
            /* not our message */
          }
          return;
        }

        const packet = new Uint8Array(ev.data);
        if (packet.length < 9) return;
        const flags = packet[0]!;
        // The pts is microseconds already, which is exactly what EncodedVideoChunk wants.
        const timestamp = Number(new DataView(ev.data).getBigUint64(1));
        const payload = packet.subarray(9);

        // A config packet (SPS/PPS) is not displayable on its own: hold it and prepend it to the
        // next key frame, so the decoder receives one self-contained chunk. Doing it this way also
        // makes mid-stream reconfiguration (a device rotation) fall out for free.
        if (flags & FLAG_CONFIG) {
          pendingConfig = payload.slice();
          if (!configured) {
            const codec = codecFromSps(pendingConfig);
            if (!codec) return fail('The video stream did not start with a readable H.264 header.');
            decoder = new VideoDecoder({
              output: paint,
              error: (e) => fail(`Video decoding failed: ${e.message}`),
            });
            decoder.configure({ codec, optimizeForLatency: true });
            configured = true;
            setStatus('streaming');
          }
          return;
        }

        if (!decoder || decoder.state !== 'configured') return;

        // Behind? Drop deltas rather than queue them: a live view wants "now", not "everything".
        const keyFrame = Boolean(flags & FLAG_KEY);
        if (!keyFrame && decoder.decodeQueueSize > MAX_DECODE_QUEUE) return;

        const data = pendingConfig
          ? (() => {
              const merged = new Uint8Array(pendingConfig.length + payload.length);
              merged.set(pendingConfig, 0);
              merged.set(payload, pendingConfig.length);
              pendingConfig = null;
              return merged;
            })()
          : payload;

        try {
          decoder.decode(
            new EncodedVideoChunk({ type: keyFrame ? 'key' : 'delta', timestamp, data }),
          );
        } catch {
          // A delta arriving before the first key frame is normal on connect; ignore and wait.
        }
      };

      ws.onerror = () => fail('The connection to the phone mirror failed.');
      ws.onclose = (ev) => {
        if (disposed) return;
        // 4404 is the relay's "not ready" code; its explanation already arrived as a text frame.
        if (ev.code === 4404 || ev.code === 1011) {
          setStatus('error');
          setError((prev) => prev ?? 'The phone mirror is not available for this agent.');
        } else {
          setStatus((prev) => (prev === 'error' ? prev : 'closed'));
        }
      };
    })();

    return () => {
      disposed = true;
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
      if (decoder && decoder.state !== 'closed') {
        try {
          decoder.close();
        } catch {
          /* already closed */
        }
      }
      wsRef.current = null;
    };
  }, [agentId, attempt]);

  // --- input ------------------------------------------------------------------------------------

  /** Canvas-relative CSS coordinates → the frame's own pixel space, which is what the relay wants. */
  const framePoint = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.width) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.round((e.clientX - rect.left) * (canvas.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (canvas.height / rect.height)),
      w: canvas.width,
      h: canvas.height,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!takeoverRef.current) return;
      const p = framePoint(e);
      if (!p) return;
      // Capture so a finger/mouse that leaves the canvas mid-drag still delivers its `up` — without
      // it the device is left believing a finger is still down.
      e.currentTarget.setPointerCapture(e.pointerId);
      send({ t: 'touch', action: 'down', ...p });
    },
    [framePoint, send],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!takeoverRef.current || e.buttons === 0) return;
      const p = framePoint(e);
      if (p) send({ t: 'touch', action: 'move', ...p });
    },
    [framePoint, send],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!takeoverRef.current) return;
      const p = framePoint(e);
      if (p) send({ t: 'touch', action: 'up', ...p });
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    [framePoint, send],
  );

  const onWheel = useCallback(
    (e: ReactWheelEvent<HTMLCanvasElement>) => {
      if (!takeoverRef.current) return;
      const p = framePoint(e);
      if (!p) return;
      // scrcpy takes scroll as a normalised [-1,1] amount, not pixels; one notch is a full unit.
      send({
        t: 'scroll',
        ...p,
        h_scroll: Math.max(-1, Math.min(1, -e.deltaX / 100)),
        v_scroll: Math.max(-1, Math.min(1, -e.deltaY / 100)),
      });
    },
    [framePoint, send],
  );

  /**
   * Keyboard. Printable characters go as *text* rather than as keycodes: mapping a browser
   * `KeyboardEvent.key` back to an Android keycode plus meta state is unreliable across layouts,
   * whereas text injection reproduces exactly what the operator typed.
   */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!takeoverRef.current) return;
      const named: Record<string, string> = {
        Enter: 'enter',
        Backspace: 'del',
        Tab: 'tab',
        Escape: 'escape',
        Delete: 'forward_del',
        ArrowUp: 'dpad_up',
        ArrowDown: 'dpad_down',
        ArrowLeft: 'dpad_left',
        ArrowRight: 'dpad_right',
        Home: 'move_home',
        End: 'move_end',
      };
      const key = named[e.key];
      if (key) {
        e.preventDefault();
        send({ t: 'key', name: key });
        return;
      }
      // A single printable character; anything longer is a modifier/function key we don't map.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        send({ t: 'text', text: e.key });
      }
    },
    [send],
  );

  /** The three hardware navigation buttons, offered as on-screen controls in the panel. */
  const pressNav = useCallback(
    (name: 'back' | 'home' | 'app_switch') => send({ t: 'key', name }),
    [send],
  );

  /** Paste (or type) a string in one go — far less painful than key-by-key for a URL or password. */
  const sendText = useCallback((text: string) => text && send({ t: 'text', text }), [send]);

  return {
    canvasRef,
    status,
    error,
    info,
    takeover,
    setTakeover,
    reconnect: () => setAttempt((a) => a + 1),
    pressNav,
    sendText,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onWheel, onKeyDown },
  };
}
