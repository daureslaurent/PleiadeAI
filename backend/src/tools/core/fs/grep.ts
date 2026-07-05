import type { Tool } from '../../types';
import { runInEnv, shq, toErrorResult } from './env-fs';

const MAX_MATCHES = 200;

/**
 * `grep` — search file contents by regex, matching OpenCode's tool name and argument schema
 * (`pattern`, `path`, `include`). Uses ripgrep when available, otherwise falls back to `grep -r`.
 * Results are `path:line:match` lines.
 */
export const grep: Tool = {
  name: 'grep',
  description:
    'Searches file contents for a regular expression and returns matching `path:line:text` lines. ' +
    'Scope with `path` (default: current directory) and `include` (a glob like "*.ts" to filter files).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search in (default: current directory).' },
      include: { type: 'string', description: 'Glob to restrict which files are searched (e.g. "*.ts").' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { result: { ok: false, error: 'pattern is required' } };
    const path = String(args.path ?? '.').trim() || '.';
    const include = args.include ? String(args.include) : '';

    const rgGlob = include ? `--glob ${shq(include)} ` : '';
    const grepInclude = include ? `--include=${shq(include)} ` : '';
    // Prefer ripgrep for speed/quality; fall back to POSIX grep -r when it isn't installed.
    const command =
      `if command -v rg >/dev/null 2>&1; then ` +
      `rg -n --no-heading --color never ${rgGlob}-e ${shq(pattern)} ${shq(path)}; ` +
      `else grep -rInE ${grepInclude}-e ${shq(pattern)} ${shq(path)}; fi ` +
      `| head -n ${MAX_MATCHES + 1}`;

    try {
      const r = await runInEnv(ctx, command);
      const lines = r.stdout.split('\n').filter(Boolean);
      // Both rg and grep exit non-zero on "no matches"; treat empty output as a clean no-match.
      if (!lines.length) {
        if (r.stderr.trim()) return { result: { ok: false, error: r.stderr.trim() } };
        return { result: { ok: true, count: 0, matches: [], output: 'no matches' } };
      }
      const truncated = lines.length > MAX_MATCHES;
      return {
        result: {
          ok: true,
          count: Math.min(lines.length, MAX_MATCHES),
          output: lines.slice(0, MAX_MATCHES).join('\n'),
          ...(truncated ? { truncated: `more than ${MAX_MATCHES} matches` } : {}),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
