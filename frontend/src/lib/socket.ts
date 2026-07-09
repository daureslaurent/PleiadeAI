import { io, type Socket } from 'socket.io-client';

/**
 * Lazily-created socket.io client. The JWT is sent in the handshake `auth` payload, matching
 * the backend's connection-time verification (spec §2). Recreated on token change.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  const token = localStorage.getItem('pleiades_token') ?? '';
  if (!socket) {
    // Empty VITE_WS_URL → connect same-origin (behind the Caddy edge). Pass `undefined` rather than
    // '' because socket.io-client mishandles an empty-string URL (it does not resolve to the origin).
    const wsUrl = import.meta.env.VITE_WS_URL || undefined;
    socket = io(wsUrl, {
      auth: { token },
      transports: ['websocket'],
    });
  }
  return socket;
}

export function resetSocket(): void {
  socket?.disconnect();
  socket = null;
}
