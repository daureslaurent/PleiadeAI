import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { verifyToken } from '../http/jwt';
import { createLogger } from '../../config/logger';
import { dockerService } from '../../isolation/docker.service';
import {
  agentContainerManager,
  IsolationNotReadyError,
} from '../../isolation/AgentContainerManager';

const log = createLogger('visual-proxy');

/** Matches `/api/agents/:id/container/visual/vnc` and captures the agent id. */
const PATH_RE = /^\/api\/agents\/([^/]+)\/container\/visual\/vnc$/;

/** Pause the container→browser pump when this much is buffered on the socket, resume once it drains. */
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;

/**
 * Live VNC relay for the Visual skill. A raw **binary** WebSocket (noVNC speaks RFB, not socket.io)
 * is bridged to the agent's loopback x11vnc by streaming over the Docker socket the backend already
 * owns: `docker exec -i <container> socat - UNIX-CONNECT:<vncSock>`. No VNC port is ever exposed on
 * any network, so the relay is network-mode agnostic (host / bridge / vpn). See `VISUAL_SKILL_PLAN.md`.
 *
 * Attaches its own `upgrade` handler and only claims requests matching `PATH_RE`; every other upgrade
 * (socket.io's `/socket.io/`) is left untouched. Auth is the same JWT as the socket handshake, passed
 * as a `?token=` query param (browsers can't set headers on a WebSocket).
 */
export function attachVisualProxy(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      return; // malformed — leave it for any other listener
    }
    const match = PATH_RE.exec(url.pathname);
    if (!match) return; // not ours (socket.io etc.)
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

  log.info('visual vnc proxy attached');
}

function rejectUpgrade(socket: Duplex, code: number): void {
  const reason = code === 401 ? 'Unauthorized' : 'Bad Request';
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Coerce a ws frame (Buffer | ArrayBuffer | Buffer[]) into a single Buffer for the child's stdin. */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data as Buffer;
}

async function startRelay(ws: WebSocket, agentId: string): Promise<void> {
  let endpoint;
  try {
    endpoint = await agentContainerManager.ensureVisual(agentId);
  } catch (err) {
    const notReady = err instanceof IsolationNotReadyError;
    log.warn({ agentId, err: String(err) }, 'visual session not ready');
    // 4404: image lacks the visual layer / container not up (client shows a "not ready" hint);
    // 1011: unexpected server error.
    ws.close(notReady ? 4404 : 1011, notReady ? 'visual not ready' : 'visual error');
    return;
  }

  const child = dockerService.spawnRaw([
    'exec', '-i', endpoint.container, 'socat', '-', `UNIX-CONNECT:${endpoint.vncSock}`,
  ]);
  log.info({ agentId, container: endpoint.container }, 'visual relay open');

  let closed = false;
  const teardown = (reason: string): void => {
    if (closed) return;
    closed = true;
    log.info({ agentId, reason }, 'visual relay closed');
    child.stdin.destroy();
    child.kill('SIGKILL');
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };

  // Container → browser, with simple backpressure so a slow client can't balloon backend memory.
  child.stdout.on('data', (buf: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(buf);
    if (ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
      child.stdout.pause();
      const resume = (): void => {
        if (ws.bufferedAmount <= BACKPRESSURE_HIGH_WATER) child.stdout.resume();
        else setTimeout(resume, 20);
      };
      setTimeout(resume, 20);
    }
  });
  child.stderr.on('data', (d: Buffer) => log.debug({ agentId, err: d.toString() }, 'socat stderr'));

  // Browser → container. noVNC sends binary RFB; ignore stray text frames.
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary && child.stdin.writable) child.stdin.write(toBuffer(data));
  });

  ws.on('close', () => teardown('ws-close'));
  ws.on('error', (err) => {
    log.warn({ agentId, err: String(err) }, 'ws error');
    teardown('ws-error');
  });
  child.on('exit', (code) => {
    log.info({ agentId, code }, 'socat exited');
    teardown('socat-exit');
  });
  child.on('error', (err) => {
    log.warn({ agentId, err: String(err) }, 'socat spawn error');
    teardown('socat-error');
  });
}
