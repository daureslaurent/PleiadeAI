import { createLogger } from '../../config/logger';
import { dockerService } from '../../isolation/docker.service';
import { HARNESS_DIR } from '../../isolation/names';
import type { GitCredentials } from './git-identity.service';

const log = createLogger('git-credentials');

/** Holds `<token hash>|<url>|<name>` — what was planted last, so an unchanged container costs one `cat`. */
const MARKER = `${HARNESS_DIR}/git.ok`;

export type PlantResult = 'planted' | 'unchanged' | 'no-git' | 'failed';

/**
 * Configure git inside an agent's container to push as the agent (GIT_SERVER_PLAN.md §2), the same
 * way `installSshKey` plants SSH material: at runtime, never in an image layer, the token on stdin
 * only. Writes `~/.git-credentials` (mode 600) with the store helper, plus `user.name`/`user.email`
 * so commits carry the agent's name. Re-plants only when the token, URL or name changed.
 */
export async function plantGitCredentials(
  container: string,
  creds: GitCredentials,
  url: string,
  displayName: string,
): Promise<PlantResult> {
  const stamp = `${creds.tokenHash}|${url}|${displayName}`;
  try {
    const current = await dockerService.exec(container, ['sh', '-c', `cat ${MARKER} 2>/dev/null`]);
    if (current.stdout.trim() === stamp) return 'unchanged';

    const hasGit = await dockerService.exec(container, ['sh', '-c', 'command -v git']);
    if (hasGit.exitCode !== 0) {
      log.warn({ container }, 'agent image has no git binary — credentials not planted');
      return 'no-git';
    }

    const u = new URL(url);
    const line = `${u.protocol}//${encodeURIComponent(creds.username)}:${encodeURIComponent(creds.token)}@${u.host}\n`;
    const write = await dockerService.exec(
      container,
      ['sh', '-c', 'umask 077; cat > "$HOME/.git-credentials" && chmod 600 "$HOME/.git-credentials"'],
      { stdin: line },
    );
    if (write.exitCode !== 0) throw new Error(write.stderr.trim() || 'write failed');

    // argv, not a shell string: the display name is operator-authored text.
    const settings: Array<[string, string]> = [
      ['credential.helper', 'store'],
      ['user.name', displayName],
      ['user.email', creds.email],
      ['init.defaultBranch', 'main'],
      ['push.autoSetupRemote', 'true'],
    ];
    for (const [key, value] of settings) {
      const res = await dockerService.exec(container, ['git', 'config', '--global', key, value]);
      if (res.exitCode !== 0) throw new Error(`git config ${key}: ${res.stderr.trim()}`);
    }

    await dockerService.exec(container, ['sh', '-c', `mkdir -p ${HARNESS_DIR} && cat > ${MARKER}`], { stdin: stamp });
    log.info({ container, username: creds.username }, 'planted git credentials');
    return 'planted';
  } catch (err) {
    log.warn({ container, err: String(err) }, 'git credential planting failed');
    return 'failed';
  }
}
