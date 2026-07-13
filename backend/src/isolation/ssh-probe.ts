import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../config/logger';
import { sshMaterialForIsolation } from './ssh.service';
import type { RemoteTarget } from './remote-ssh';

const log = createLogger('isolation-ssh-probe');

/**
 * Operator-facing SSH probes for the `ssh` network mode, run from the backend (not from an agent
 * container — a profile can be configured before any agent has ever booted one).
 *
 * These exist so the operator can pin a host key *deliberately*, having seen its fingerprint, which
 * is what lets execution itself run with `StrictHostKeyChecking=yes` and no trust-on-first-use.
 */

/** Run a binary with argv, capturing output. No shell — argv never goes through a command line. */
function run(
  bin: string,
  argv: string[],
  opts: { timeoutMs: number; stdin?: string } = { timeoutMs: 15_000 },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, argv);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    if (opts.stdin !== undefined) {
      child.stdin.on('error', () => {
        /* the child may exit before draining stdin — swallow EPIPE. */
      });
      child.stdin.end(opts.stdin);
    }
  });
}

export interface ScannedHostKey {
  /** The `known_hosts` line itself. */
  line: string;
  type: string;
  /** SHA256 fingerprint, for the operator to compare against the remote's own `ssh-keygen -lf`. */
  fingerprint: string;
}

/**
 * Fetch the remote's host keys (`ssh-keyscan`) and their fingerprints. Deliberately does NOT save
 * them: the operator reviews the fingerprint and pins it explicitly, so a MITM on this one scan
 * can't silently become the trusted key.
 */
export async function scanHostKeys(target: RemoteTarget): Promise<ScannedHostKey[]> {
  const scan = await run('ssh-keyscan', ['-T', '10', '-p', String(target.port), target.host], {
    timeoutMs: 20_000,
  });
  const lines = scan.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (!lines.length) {
    throw new Error(
      `No host key returned by ${target.host}:${target.port}. ${scan.stderr.trim() || 'Check the host/port and that sshd is reachable from the backend.'}`,
    );
  }

  const keys: ScannedHostKey[] = [];
  for (const line of lines) {
    // `ssh-keygen -lf -` prints "<bits> SHA256:<hash> <comment> (<TYPE>)" for the key fed on stdin.
    const fp = await run('ssh-keygen', ['-lf', '-'], { timeoutMs: 10_000, stdin: `${line}\n` });
    keys.push({
      line,
      type: line.split(/\s+/)[1] ?? 'unknown',
      fingerprint: fp.stdout.trim() || '(fingerprint unavailable)',
    });
  }
  return keys;
}

/** Result of an end-to-end connectivity + auth check against the remote. */
export interface SshTestResult {
  ok: boolean;
  /** `uname -a` + `whoami` from the remote when ok; the SSH error otherwise. */
  detail: string;
}

/**
 * Full dress rehearsal of the execution hop: connect with the profile's own key, verify the host key
 * against the profile's pinned `known_hosts`, and run a harmless command. Same options the executor
 * uses (BatchMode, StrictHostKeyChecking) so a pass here means agent tools will work.
 *
 * Caveat: this runs from the backend container, whose route to the remote is the same NATed bridge
 * an `ssh`-mode agent container uses — close enough to be a meaningful preflight.
 */
export async function testRemote(isoId: string, target: RemoteTarget): Promise<SshTestResult> {
  const material = await sshMaterialForIsolation(isoId);
  if (!material.privateKey) {
    return { ok: false, detail: 'This profile has no SSH private key. Generate or paste one first.' };
  }
  if (!material.knownHosts?.trim()) {
    return {
      ok: false,
      detail:
        'This profile has no pinned host key. Click "Scan host key", check the fingerprint, and pin it — execution refuses to connect to an unverified host.',
    };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pl-ssh-'));
  const keyFile = path.join(dir, 'id');
  const khFile = path.join(dir, 'known_hosts');
  try {
    await fs.writeFile(keyFile, nl(material.privateKey), { mode: 0o600 });
    await fs.writeFile(khFile, nl(material.knownHosts), { mode: 0o644 });

    const res = await run(
      'ssh',
      [
        '-T',
        '-i', keyFile,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${khFile}`,
        '-o', 'ConnectTimeout=10',
        '-o', 'LogLevel=ERROR',
        '-p', String(target.port),
        `${target.user}@${target.host}`,
        '--',
        'whoami; uname -a',
      ],
      { timeoutMs: 25_000 },
    );

    if (res.exitCode === 0) return { ok: true, detail: res.stdout.trim() };
    log.warn({ isoId, host: target.host, exit: res.exitCode }, 'ssh test failed');
    return { ok: false, detail: res.stderr.trim() || `ssh exited ${res.exitCode}` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** OpenSSH rejects a key file that doesn't end in a newline ("invalid format"). */
function nl(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
