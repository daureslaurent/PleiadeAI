import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { verifyToken } from '../http/jwt';
import { createLogger } from '../../config/logger';
import { dockerService } from '../../isolation/docker.service';
import {
  agentContainerManager,
  IsolationNotReadyError,
  type AndroidMirrorEndpoint,
} from '../../isolation/AgentContainerManager';
import {
  ScrcpyVideoParser,
  encodeKeyPress,
  encodeScroll,
  encodeText,
  encodeTouch,
  isKeyName,
  KEYCODES,
  MOTION_DOWN,
  MOTION_MOVE,
  MOTION_UP,
  type ScrcpyMeta,
} from '../../isolation/scrcpy';

const log = createLogger('android-proxy');

/** Matches `/api/agents/:id/container/android/mirror` and captures the agent id. */
const PATH_RE = /^\/api\/agents\/([^/]+)\/container\/android\/mirror$/;

/** Pause the device→browser pump when this much is buffered on the socket, resume once it drains. */
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;

/** Flags in our own 9-byte packet header (the browser's decoder needs nothing more). */
const OUT_FLAG_CONFIG = 1;
const OUT_FLAG_KEY = 2;

/**
 * Live phone mirror relay. The Android counterpart of `visual-proxy.ts`, and structurally the same
 * idea: a raw **binary** WebSocket bridged to something inside the agent's container by streaming
 * over the Docker socket the backend already owns, so no port is exposed on any network and the
 * relay is network-mode agnostic.
 *
 * What differs is the payload. There is no VNC server on a phone, so the picture comes from scrcpy:
 * its server runs *on the device*, encodes the screen to H.264, and listens on an abstract socket
 * that `adb forward` bridges to a container-local TCP port. We open **two** connections to that port
 * — scrcpy hands the first to video and the second to control — and:
 *
 *  - re-frame the video stream into one binary WS message per access unit, which the browser feeds
 *    straight into a WebCodecs `VideoDecoder` (see `useAndroidMirror.ts`);
 *  - accept a small JSON control vocabulary from the browser and encode it into scrcpy's binary
 *    control messages here, so the version-specific byte layouts stay in `isolation/scrcpy.ts` and
 *    never leak into the frontend.
 *
 * Ordering matters and is enforced rather than hoped for: scrcpy sends its dummy handshake byte the
 * instant it accepts the video socket, so the control connection is only opened *after* that byte
 * arrives. Without that, a slow `docker exec` could let control connect first and the two streams
 * would be swapped.
 */
export function attachAndroidProxy(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return; // malformed — leave it for any other listener
    }
    const match = PATH_RE.exec(url.pathname);
    if (!match) return; // not ours (socket.io, the visual relay)
    const agentId = match[1]!;

    const token = url.searchParams.get('token');
    if (!token) return rejectUpgrade(socket, 401);
    try {
      verifyToken(token);
    } catch {
      return rejectUpgrade(socket, 401);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void startRelay(ws, agentId);
    });
  });

  log.info('android mirror proxy attached');
}

function rejectUpgrade(socket: Duplex, code: number): void {
  const reason = code === 401 ? 'Unauthorized' : 'Bad Request';
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Open one `socat` stream from the container to the forwarded scrcpy port. */
function connectStream(endpoint: AndroidMirrorEndpoint): ChildProcessWithoutNullStreams {
  return dockerService.spawnRaw([
    'exec', '-i', endpoint.container, 'socat', '-', `TCP:127.0.0.1:${endpoint.port}`,
  ]);
}

async function startRelay(ws: WebSocket, agentId: string): Promise<void> {
  let endpoint: AndroidMirrorEndpoint;
  try {
    endpoint = await agentContainerManager.ensureAndroidMirror(agentId);
  } catch (err) {
    const notReady = err instanceof IsolationNotReadyError;
    log.warn({ agentId, err: String(err) }, 'android mirror not ready');
    // The message is the actionable part, and a WS close reason is capped at 123 bytes, so send it
    // as a text frame first and only then close with the 4404 "not ready" / 1011 "error" code.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
    }
    ws.close(notReady ? 4404 : 1011, notReady ? 'mirror not ready' : 'mirror error');
    return;
  }

  const video = connectStream(endpoint);
  let control: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  let meta: ScrcpyMeta | null = null;

  log.info({ agentId, container: endpoint.container, port: endpoint.port }, 'android mirror relay open');

  const teardown = (reason: string): void => {
    if (closed) return;
    closed = true;
    log.info({ agentId, reason }, 'android mirror relay closed');
    for (const child of [video, control]) {
      if (!child) continue;
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
    // scrcpy's server exits by itself once its sockets drop; drop the now-dangling adb forward too.
    void agentContainerManager
      .cleanupAndroidMirror(endpoint)
      .catch((err) => log.debug({ agentId, err: String(err) }, 'mirror cleanup failed'));
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };

  // --- device → browser -------------------------------------------------------------------------

  const parser = new ScrcpyVideoParser(
    (m) => {
      meta = m;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'meta', device: endpoint.deviceName, ...m }));
      }
    },
    (packet) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const header = Buffer.alloc(9);
      header.writeUInt8((packet.config ? OUT_FLAG_CONFIG : 0) | (packet.keyFrame ? OUT_FLAG_KEY : 0), 0);
      header.writeBigUInt64BE(packet.pts, 1);
      ws.send(Buffer.concat([header, packet.data]));
    },
  );

  video.stdout.on('data', (buf: Buffer) => {
    // The very first byte is scrcpy's dummy handshake, sent the moment the video socket is accepted.
    // That is our cue that video won the race, so control can safely connect as the second socket.
    if (!control) control = openControl();
    parser.push(buf);
    if (ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
      video.stdout.pause();
      const resume = (): void => {
        if (ws.bufferedAmount <= BACKPRESSURE_HIGH_WATER) video.stdout.resume();
        else setTimeout(resume, 20);
      };
      setTimeout(resume, 20);
    }
  });
  video.stderr.on('data', (d: Buffer) => log.debug({ agentId, err: d.toString() }, 'video socat stderr'));
  video.on('exit', (code) => {
    log.info({ agentId, code }, 'video socat exited');
    teardown('video-exit');
  });
  video.on('error', (err) => {
    log.warn({ agentId, err: String(err) }, 'video socat spawn error');
    teardown('video-error');
  });

  function openControl(): ChildProcessWithoutNullStreams {
    const child = connectStream(endpoint);
    // The device also talks back on this socket (clipboard sync, acks). The panel offers no
    // clipboard feature, so drain it rather than let the pipe fill and stall the device's writer.
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', (err) => log.warn({ agentId, err: String(err) }, 'control socat spawn error'));
    return child;
  }

  // --- browser → device -------------------------------------------------------------------------

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary || !control?.stdin.writable) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(toText(data)) as Record<string, unknown>;
    } catch {
      return; // a malformed frame is a client bug; dropping it is the whole response
    }
    const encoded = encodeControl(msg, meta);
    for (const buf of encoded) control.stdin.write(buf);
  });

  ws.on('close', () => teardown('ws-close'));
  ws.on('error', (err) => {
    log.warn({ agentId, err: String(err) }, 'ws error');
    teardown('ws-error');
  });
}

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return (data as Buffer).toString('utf8');
}

const TOUCH_ACTIONS: Record<string, number> = { down: MOTION_DOWN, move: MOTION_MOVE, up: MOTION_UP };

/**
 * Translate one browser control message into scrcpy's binary form. Returns an empty list for
 * anything unrecognised or out of range — a panel bug must never be able to inject a malformed
 * message into the device's control socket, which would desynchronise the stream for the session.
 *
 * Coordinates arrive in the *video frame's* space and are passed through unchanged: scrcpy's server
 * rescales them to the real screen, which is what lets the mirror run at a reduced `max_size`
 * without the browser ever knowing the device's true resolution.
 */
function encodeControl(msg: Record<string, unknown>, meta: ScrcpyMeta | null): Buffer[] {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  const width = num(msg.w) || meta?.width || 0;
  const height = num(msg.h) || meta?.height || 0;

  switch (msg.t) {
    case 'touch': {
      const action = TOUCH_ACTIONS[String(msg.action)];
      const x = num(msg.x);
      const y = num(msg.y);
      if (action === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !width || !height) return [];
      return [encodeTouch({ action, x, y, width, height })];
    }
    case 'scroll': {
      const x = num(msg.x);
      const y = num(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !width || !height) return [];
      return [
        encodeScroll({
          x,
          y,
          width,
          height,
          hscroll: num(msg.h_scroll) || 0,
          vscroll: num(msg.v_scroll) || 0,
        }),
      ];
    }
    case 'key': {
      const name = String(msg.name ?? '');
      return isKeyName(name) ? [encodeKeyPress(KEYCODES[name])] : [];
    }
    case 'text': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      return text ? encodeText(text) : [];
    }
    default:
      return [];
  }
}
