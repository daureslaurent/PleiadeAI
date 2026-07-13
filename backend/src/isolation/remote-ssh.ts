import { HARNESS_DIR } from './names';

/**
 * `ssh` network mode (spec: SSH_ISOLATION_PLAN.md) — the transport that turns the agent's container
 * into a jump box: `bash`, the file tools and skills all execute on a **remote host** over SSH, and
 * the agent never sees the hop (its tool schemas are unchanged).
 *
 * Everything here builds *argv arrays* for `docker exec`, so there is no container-side shell to
 * quote against. The remote side is the only quoting surface, and we sidestep it entirely by
 * base64-encoding the script (see `remoteEval`).
 */

/** Where an agent's commands run in `ssh` mode. */
export interface RemoteTarget {
  host: string;
  port: number;
  user: string;
}

/** Read the (optional) remote target off an isolation profile; `null` unless fully configured. */
export function remoteTargetOf(iso: {
  network?: string;
  ssh_remote_host?: string;
  ssh_remote_port?: number;
  ssh_remote_user?: string;
}): RemoteTarget | null {
  if (iso.network !== 'ssh') return null;
  const host = (iso.ssh_remote_host || '').trim();
  const user = (iso.ssh_remote_user || '').trim();
  if (!host || !user) return null;
  return { host, user, port: Number(iso.ssh_remote_port) || 22 };
}

/** Directory holding the SSH connection-multiplexing sockets *inside the agent container*. */
const CONTROL_DIR = `${HARNESS_DIR}/ssh`;

// Remote-side layout, under the SSH user's home (which is also the agent's working directory).
const REMOTE_DIR = '$HOME/.pleiades';
const REMOTE_BIN = `${REMOTE_DIR}/bin`;
const REMOTE_SESSION_CWD = `${REMOTE_DIR}/session/cwd`;
export const REMOTE_PY_RUNNER = `${REMOTE_BIN}/py_runner.py`;
export const REMOTE_NODE_RUNNER = `${REMOTE_BIN}/node_runner.cjs`;

/**
 * OpenSSH options for every hop.
 *
 * - `BatchMode` — never prompt for a password/passphrase; fail fast instead of hanging a tool call.
 * - `StrictHostKeyChecking` — the host key must already be pinned in the container's `known_hosts`
 *   (the operator scans it from the Isolation page). A changed key aborts rather than reconnecting.
 * - `ControlMaster`/`ControlPersist` — one shared connection per container, so the 2nd..Nth command
 *   skip the TCP + auth handshake (~200ms → ~5ms). Persists for the profile's idle timeout.
 * - `LogLevel=ERROR` — drop the "Warning: Permanently added…" banner noise from stderr (which tools
 *   surface to the model) while keeping real failures.
 */
function sshOptions(controlPersistSec: number): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${CONTROL_DIR}/cm-%r@%h:%p`,
    '-o', `ControlPersist=${Math.max(60, Math.floor(controlPersistSec))}`,
  ];
}

/**
 * Full `ssh` argv (for `docker exec`) running `remoteCommand` on the target. `remoteCommand` is
 * handed to the remote login shell verbatim, so callers must pass something already safe — use
 * `remoteEval()` for anything containing agent-supplied text.
 */
export function sshArgv(
  target: RemoteTarget,
  remoteCommand: string,
  opts: { controlPersistSec: number },
): string[] {
  return [
    'ssh',
    ...sshOptions(opts.controlPersistSec),
    '-p', String(target.port),
    `${target.user}@${target.host}`,
    '--',
    remoteCommand,
  ];
}

/**
 * Wrap an arbitrary shell script so the remote shell runs it **verbatim**, with no quoting surface:
 * the script crosses as base64 (`[A-Za-z0-9+/=]` only — nothing a shell can interpret) and is
 * decoded in a command substitution.
 *
 * `eval "$(… | base64 -d)"` rather than piping into `bash` on purpose: a pipe would consume the
 * remote command's **stdin**, and the file tools stream multi-megabyte base64 payloads there to stay
 * under `ARG_MAX`. With `eval`, stdin stays connected to the SSH channel.
 */
export function remoteEval(script: string): string {
  const b64 = Buffer.from(script, 'utf8').toString('base64');
  return `eval "$(printf %s ${b64} | base64 -d)"`;
}

/**
 * The remote twin of the container's `wrapWithSession`: restore the cwd persisted by the previous
 * call (default: the SSH user's `$HOME`), run the command, persist the resulting `$PWD`, and preserve
 * the command's exit code. This is what makes a `cd` in one `bash` call carry into the next one — on
 * the remote machine. The command is embedded on its own lines so heredocs / multi-line scripts work.
 */
export function remoteSessionScript(command: string): string {
  return [
    `mkdir -p ${REMOTE_DIR}/session 2>/dev/null`,
    `cd "$(cat ${REMOTE_SESSION_CWD} 2>/dev/null)" 2>/dev/null || cd "$HOME" 2>/dev/null || cd /`,
    command,
    `__pl_ec=$?`,
    `printf '%s' "$PWD" > ${REMOTE_SESSION_CWD} 2>/dev/null`,
    `exit $__pl_ec`,
  ].join('\n');
}

/** Create the container-side directory the SSH control sockets live in (mode 700). */
export function controlDirScript(): string[] {
  return ['sh', '-c', `mkdir -p ${CONTROL_DIR} && chmod 700 ${CONTROL_DIR}`];
}

/** Remote-side `mkdir` for the harness + session dirs. Idempotent. */
export const REMOTE_MKDIR = `mkdir -p ${REMOTE_BIN} ${REMOTE_DIR}/session`;

/** Remote-side command that writes a harness file from stdin (mode 700 dir, 644 file). */
export function remoteWriteFile(path: string): string {
  return `cat > ${path}`;
}

/**
 * Map a raw SSH failure into an operator-actionable message. These surface to the agent as a tool
 * error and to the UI as an isolation error, so they must say what to fix, not just what broke.
 */
export function explainSshFailure(target: RemoteTarget, stderr: string, exitCode: number): string {
  const where = `${target.user}@${target.host}:${target.port}`;
  const err = stderr.trim();

  if (/host key verification failed|remote host identification has changed/i.test(err)) {
    return `SSH host key verification failed for ${where}. The remote's host key is not pinned (or has changed). Open the Isolation page and click "Scan host key" to review and pin the current fingerprint.`;
  }
  if (/permission denied|too many authentication failures/i.test(err)) {
    return `SSH authentication was refused by ${where}. Make sure this profile's public key is in the remote user's ~/.ssh/authorized_keys.`;
  }
  if (/connection refused|no route to host|network is unreachable|name or service not known|timed out/i.test(err)) {
    return `Cannot reach ${where}: ${err || 'connection failed'}. Check the host/port and that sshd is running.`;
  }
  if (/(^|\W)(ssh: not found|ssh: command not found)/i.test(err) || exitCode === 127) {
    return `The agent's Docker image has no \`ssh\` client. Open the Images page, add \`openssh-client\` to its Dockerfile, and rebuild.`;
  }
  return `SSH to ${where} failed (exit ${exitCode})${err ? `: ${err}` : ''}`;
}
