import { spawn } from 'node:child_process';
import { createLogger } from '../../config/logger';
import { env } from '../../config/env';
import type { Tool } from '../types';

const log = createLogger('tool:bash');

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap output fed back to the model so a chatty command can't blow the context window. */
const MAX_OUTPUT_CHARS = 30_000;

/**
 * `bash` — terminal tool matching OpenCode's name and argument schema so OpenCode-tuned models
 * emit compatible tool calls. Executes a shell command inside the `pleiade_backend` container
 * (spec §3: all execution is bounded to the container; reach external hosts via network/SSH).
 *
 * Each call is a fresh non-interactive `bash -c` (no persistent session state between calls).
 */
export const bash: Tool = {
  name: 'bash',
  description:
    "Executes a bash command in the agent's Linux execution environment and returns its combined stdout/stderr. Provide a clear `description` of what the command does.",
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to execute.' },
      timeout: {
        type: 'number',
        description: `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS}).`,
      },
      description: {
        type: 'string',
        description: 'Clear, concise description of what this command does in 5-10 words.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  execute(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) {
      return Promise.resolve({ result: { ok: false, error: 'command is required' } });
    }
    const timeout = Math.min(
      Math.max(Number(args.timeout) || DEFAULT_TIMEOUT_MS, 1_000),
      MAX_TIMEOUT_MS,
    );

    // Isolation is enabled but the container isn't ready — hard error, never fall back to backend.
    if (ctx.isolationError) {
      return Promise.resolve({ result: { ok: false, error: ctx.isolationError } });
    }

    log.info({ command, timeout, isolated: Boolean(ctx.exec) }, 'bash exec');

    // Isolated agents: run the command inside the agent's dedicated container via `docker exec`.
    if (ctx.exec) {
      return ctx.exec
        .run(command, { timeoutMs: timeout, onOutput: (s) => ctx.emitOutput?.(s) })
        .then((res) => ({
          result: {
            ok: !res.timedOut && res.exitCode === 0,
            exit_code: res.timedOut ? 124 : res.exitCode,
            output: res.timedOut
              ? `${truncate(res.stdout + (res.stderr ? `\n${res.stderr}` : ''))}\n[timed out after ${timeout}ms]`
              : truncate(res.stdout + (res.stderr ? `\n${res.stderr}` : '')),
          },
        }));
    }

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: env.BASH_CWD,
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeout);

      child.stdout.on('data', (d: Buffer) => {
        const s = d.toString();
        stdout += s;
        ctx.emitOutput?.(s); // live stream to the UI terminal block
      });
      child.stderr.on('data', (d: Buffer) => {
        const s = d.toString();
        stderr += s;
        ctx.emitOutput?.(s);
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ result: { ok: false, error: err.message } });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const output = truncate(stdout + (stderr ? `\n${stderr}` : ''));
        resolve({
          result: {
            ok: !timedOut && code === 0,
            exit_code: timedOut ? 124 : (code ?? -1),
            output: timedOut ? `${output}\n[timed out after ${timeout}ms]` : output,
          },
        });
      });
    });
  },
};

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}
