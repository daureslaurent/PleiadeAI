import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';

const exec = promisify(execFile);
const log = createLogger('migration-restart');

/** Compose's name for this service, used when the container id can't be resolved. */
const FALLBACK_CONTAINER = 'pleiades_backend';

/**
 * Restart the backend after a restore, through the same host docker socket the isolation layer
 * already uses (spec §6, step 4).
 *
 * A restart is not cosmetic here. Mongoose models, the Agenda job definitions, the settings
 * singleton, the inference runtime config and every in-process cache were built from the *old*
 * database; after a restore they describe an instance that no longer exists. Re-reading all of it in
 * place would mean re-running half of boot, so the honest move is to boot.
 *
 * Docker sets a container's hostname to its own short id, which is what lets a container restart
 * itself without being told its name.
 */
export async function restartSelf(): Promise<{ requested: boolean; detail: string }> {
  const target = await resolveContainer();
  if (!target) {
    const detail = 'no reachable docker container to restart (is /var/run/docker.sock mounted?)';
    log.error({ detail }, 'self-restart unavailable — operator must restart by hand');
    return { requested: false, detail };
  }

  // `spawn` reports only whether the *launch* succeeded, and `docker restart` on a container that
  // does not exist still launches fine — so the target is confirmed to exist first, above. Awaiting
  // the command itself is not an option: it stops this very process.
  const child = spawn(env.DOCKER_BIN, ['restart', target], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => log.error({ err, container: target }, 'docker restart could not be launched'));
  child.unref();
  log.warn({ container: target }, 'restart requested after instance restore');
  return { requested: true, detail: `restarting container ${target}` };
}

/** The container this process is in, else the compose service name — whichever docker confirms. */
async function resolveContainer(): Promise<string | null> {
  for (const candidate of [os.hostname(), FALLBACK_CONTAINER]) {
    if (!candidate) continue;
    try {
      await exec(env.DOCKER_BIN, ['inspect', '--format', '{{.Id}}', candidate], { timeout: 10_000 });
      return candidate;
    } catch {
      // Not a container (a bare-metal hostname), or the daemon is unreachable — try the next.
    }
  }
  return null;
}
