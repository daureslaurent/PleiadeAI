// Periodic update-availability check. We can't run git inside the container, so
// this drops a `check` trigger for the host watcher (check_run.sh) which does the
// `git fetch` + comparison and writes status.json. We then read that file back so
// the UI can surface "an update is available" (the sidebar pin polls the API).
//
// Everything here is gated by the `update_enabled` setting (the same master switch
// as the "Update app" action) and by the host bridge being wired up.
import { createLogger } from '../config/logger';
import { settingsService } from '../domain/settings/settings.service';
import { requestCheck, readUpdateStatus, getUpdateReadiness, type UpdateStatus } from './update';

const log = createLogger('update-check');

let checkInterval: ReturnType<typeof setInterval> | null = null;

// How long to wait for the host watcher to produce a fresh status.json after we
// drop the trigger (git fetch is quick; this is a generous ceiling).
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Trigger a host-side check and return the resulting status. No-op (returns the last known
 * status) when updates are disabled or the host bridge isn't ready. Safe to call
 * concurrently — the worst case is a redundant `git fetch` on the host.
 */
export async function runUpdateCheck(): Promise<UpdateStatus | null> {
  const settings = await settingsService.get();
  if (!settings.update_enabled) return readUpdateStatus();

  const readiness = await getUpdateReadiness();
  if (!readiness.ready) {
    log.debug({ reason: readiness.reason }, 'Update check skipped — host bridge not ready');
    return readUpdateStatus();
  }

  const before = await readUpdateStatus();
  const beforeAt = before?.checkedAt ?? '';

  try {
    await requestCheck({ by: 'auto' });
  } catch (err) {
    log.warn({ err }, 'Failed to drop update-check trigger');
    return before;
  }

  // Poll until the host writes a newer status.json (checkedAt advances).
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let status: UpdateStatus | null = before;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const next = await readUpdateStatus();
    if (next && next.checkedAt !== beforeAt) {
      status = next;
      break;
    }
  }

  if (!status || status.checkedAt === beforeAt) {
    log.warn('Update check timed out waiting for host status.json');
    return status;
  }
  if (status.error) {
    log.warn({ error: status.error }, 'Host update check reported an error');
    return status;
  }

  if (status.behindBy > 0) {
    log.info(
      { behindBy: status.behindBy, remoteSha: status.remoteShortSha, latest: status.commits[0]?.subject ?? '' },
      'Update available',
    );
  }
  return status;
}

/**
 * (Re)start the periodic check loop. `intervalHours` comes from the
 * `update_check_interval_hours` setting (default 1). Also runs one check shortly
 * after startup so the pin reflects reality without waiting a full interval.
 */
export function scheduleUpdateCheck(intervalHours: number): void {
  stopUpdateCheck();

  const hours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 1;
  const ms = Math.max(60_000, Math.round(hours * 60 * 60 * 1000));

  // Kick off an initial check a short while after boot (let the server + host bridge
  // settle first), then repeat on the interval.
  setTimeout(() => {
    runUpdateCheck().catch((err) => log.warn({ err }, 'Initial update check failed'));
  }, 15_000);

  checkInterval = setInterval(() => {
    runUpdateCheck().catch((err) => log.warn({ err }, 'Scheduled update check failed'));
  }, ms);

  log.info({ everyHours: hours }, 'Update check scheduled');
}

export function stopUpdateCheck(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}
