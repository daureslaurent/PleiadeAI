import { spawn } from 'node:child_process';
import { env } from '../../../config/env';
import type { ToolContext } from '../../types';

/**
 * Shared execution substrate for the OpenCode-compatible file tools (`read`, `write`, `edit`,
 * `list`, `glob`, `grep`, `patch`).
 *
 * Every operation runs as a shell command in the agent's execution environment — inside its
 * dedicated Docker container when isolation is active (`ctx.exec`), otherwise on the backend
 * (`env.BASH_CWD`). This mirrors `bash` so file access inherits the exact same isolation
 * guarantee: when isolation is enabled but not ready, we hard-error instead of touching the
 * backend filesystem (spec §3).
 *
 * File contents cross the shell boundary base64-encoded, so arbitrary bytes never need quoting.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface EnvExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Isolation is on but the container isn't ready — file tools must surface this, never fall back. */
export class IsolationBlockedError extends Error {}

/** An expected, user-facing file-operation failure (missing file, write denied, …). */
export class FileOpError extends Error {}

/** Single-quote a string for safe interpolation into a `bash -lc` command. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run a shell command in the agent's environment (container when isolated, else backend). */
export async function runInEnv(
  ctx: ToolContext,
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<EnvExecResult> {
  if (ctx.isolationError) throw new IsolationBlockedError(ctx.isolationError);

  if (ctx.exec) return ctx.exec.run(command, { timeoutMs });

  return new Promise<EnvExecResult>((resolve) => {
    // `-c` (not `-lc`): a login shell would source profiles whose stdout could corrupt the
    // base64 payloads `read` relies on. The container path runs in its own controlled shell.
    const child = spawn('bash', ['-c', command], { cwd: env.BASH_CWD, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? -1), stdout, stderr, timedOut });
    });
  });
}

/** Directory portion of a POSIX path (no trailing slash), or `.` for a bare filename. */
export function dirName(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return '.';
  return p.slice(0, idx) || '/';
}

/** Read a file's raw bytes out of the environment via base64. Throws `FileOpError` if missing. */
export async function readFileBytes(ctx: ToolContext, path: string): Promise<Buffer> {
  const r = await runInEnv(ctx, `base64 ${shq(path)}`);
  if (r.exitCode !== 0) {
    throw new FileOpError(r.stderr.trim() || `cannot read file: ${path}`);
  }
  return Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64');
}

/** Write raw bytes to a file in the environment (creating parent dirs), via base64. */
export async function writeFileBytes(ctx: ToolContext, path: string, content: Buffer): Promise<void> {
  const b64 = content.toString('base64');
  const cmd = `mkdir -p ${shq(dirName(path))} && printf %s ${shq(b64)} | base64 -d > ${shq(path)}`;
  const r = await runInEnv(ctx, cmd);
  if (r.exitCode !== 0) {
    throw new FileOpError(r.stderr.trim() || `cannot write file: ${path}`);
  }
}

/** Does the path exist as a regular file? */
export async function fileExists(ctx: ToolContext, path: string): Promise<boolean> {
  const r = await runInEnv(ctx, `test -f ${shq(path)} && echo yes || echo no`);
  return r.stdout.trim() === 'yes';
}

/** Map an unexpected throw into the standard `{ ok: false, error }` tool result payload. */
export function toErrorResult(err: unknown): { result: { ok: false; error: string } } {
  const msg = err instanceof Error ? err.message : String(err);
  return { result: { ok: false, error: msg } };
}
