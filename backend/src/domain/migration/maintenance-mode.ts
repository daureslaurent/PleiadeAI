import type { Server as SocketServer } from 'socket.io';
import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../../config/logger';
import { getAgenda } from '../../autonomy/agenda.setup';
import { flowTimerScheduler } from '../../flows/TimerScheduler';
import { streamRegistry } from '../../streaming/StreamRegistry';
import { monitorPoller } from '../monitor/monitor.poller';
import { endpointHealth } from '../../inference/endpoint-health';
import { telegramBot } from '../../telegram/TelegramBot';

const log = createLogger('maintenance-mode');

/**
 * Quiescing the instance so a restore can replace the database it is running on (spec §6, step 2).
 *
 * The problem this solves is concrete: Agenda holds a cron tick that may fire mid-restore, the flow
 * timers hold their own intervals, the monitor and health pollers write documents every few seconds,
 * and a live chat socket can start an agent turn that writes to a collection between its drop and
 * its refill. Any of those lands a row in a collection that has already been restored, and the
 * post-restore census then reports a difference nobody can explain.
 *
 * So everything that writes on its own schedule is stopped first, every socket is dropped, and the
 * HTTP surface is narrowed to the migration routes themselves. There is no graceful exit: the
 * restore ends in a container restart, and the one path back for a *failed* restore is
 * {@link leaveMaintenance}, which re-arms the pollers so the operator can retry or investigate.
 */

let active = false;
let reason = '';
let io: SocketServer | null = null;

/** Handed the socket server at boot so maintenance can drop connections without a circular import. */
export function registerSocketServer(server: SocketServer): void {
  io = server;
}

export function inMaintenance(): boolean {
  return active;
}

export function maintenanceReason(): string {
  return reason;
}

export async function enterMaintenance(why: string): Promise<void> {
  if (active) return;
  active = true;
  reason = why;
  log.warn({ why }, 'entering maintenance mode — background work stopped');

  // Order matters only in that the schedulers go before the sockets: a socket dropped first could
  // still be answered by a job that was already in flight.
  //
  // Each stop is individually guarded. A restore is the last thing that should be abandoned because
  // one scheduler was not running — `getAgenda()` *throws* when Agenda never started, and a boot
  // that failed to reach Agenda is exactly when an operator is most likely to be restoring.
  await stopQuietly('agenda', async () => {
    await getAgenda().stop();
  });
  await stopQuietly('flow timers', () => flowTimerScheduler.stopAll());
  await stopQuietly('streams', () => streamRegistry.stopAll());
  await stopQuietly('monitor poller', async () => monitorPoller.stop());
  await stopQuietly('endpoint health', async () => endpointHealth.stop());
  await stopQuietly('telegram bot', async () => telegramBot.stop());

  if (io) {
    io.disconnectSockets(true);
    log.info('all websockets dropped');
  }
}

/** Stop one background service without letting its absence abort the restore. */
async function stopQuietly(what: string, stop: () => Promise<unknown>): Promise<void> {
  try {
    await stop();
  } catch (err) {
    log.warn({ err, what }, 'background service did not stop cleanly — continuing');
  }
}

/** Only for a restore that failed: puts the instance back to work without a restart. */
export async function leaveMaintenance(): Promise<void> {
  if (!active) return;
  active = false;
  reason = '';
  await stopQuietly('agenda restart', async () => {
    await getAgenda().start();
  });
  monitorPoller.start();
  endpointHealth.start();
  log.warn('left maintenance mode');
}

/**
 * Refuse everything but the migration surface while a restore is in progress.
 *
 * `/api/auth` and `/health` stay open so the operator can still be authenticated and the container's
 * healthcheck keeps passing — a 503 there would have Docker restart the backend in the middle of the
 * restore, which is the one thing this mode exists to prevent.
 */
export function maintenanceGuard(req: Request, res: Response, next: NextFunction): void {
  if (!active) {
    next();
    return;
  }
  const path = req.path;
  if (path.startsWith('/api/migration') || path.startsWith('/api/auth') || path === '/health') {
    next();
    return;
  }
  res.status(503).json({ error: 'instance is in maintenance mode', reason });
}
