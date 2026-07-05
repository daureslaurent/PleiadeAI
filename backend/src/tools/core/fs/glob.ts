import type { Tool } from '../../types';
import { runInEnv, shq, toErrorResult } from './env-fs';

const MAX_RESULTS = 200;
/** Reject shell metacharacters so `pattern` can only ever glob, never chain commands. */
const UNSAFE = /[;|&$`\n<>()!{}"'\\]/;

/**
 * `glob` — find files by glob pattern, matching OpenCode's tool name and argument schema
 * (`pattern`, `path`). Supports `**` (via bash globstar); results are sorted newest-first.
 */
export const glob: Tool = {
  name: 'glob',
  description:
    'Finds files matching a glob pattern (e.g. "**/*.ts", "src/**/*.py"), sorted by modification ' +
    'time (newest first). Search from `path` (default: current directory).',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against.' },
      path: { type: 'string', description: 'The directory to search in (default: current directory).' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) return { result: { ok: false, error: 'pattern is required' } };
    if (UNSAFE.test(pattern)) {
      return { result: { ok: false, error: 'pattern contains unsupported characters' } };
    }
    const path = String(args.path ?? '.').trim() || '.';

    // globstar/nullglob expand `**` and yield nothing (not the literal) when unmatched. The pattern
    // is injected unquoted so the shell expands it; UNSAFE has already rejected metacharacters.
    const script =
      `cd ${shq(path)} 2>/dev/null || exit 2; shopt -s globstar nullglob dotglob; ` +
      `for f in ${pattern}; do ` +
      `[ -e "$f" ] && printf '%s\\t%s\\n' "$(stat -c %Y \"$f\" 2>/dev/null || echo 0)" "$f"; ` +
      `done | sort -rn | cut -f2- | head -n ${MAX_RESULTS + 1}`;

    try {
      const r = await runInEnv(ctx, script);
      if (r.exitCode === 2) return { result: { ok: false, error: `no such directory: ${path}` } };
      const files = r.stdout.split('\n').filter(Boolean);
      const truncated = files.length > MAX_RESULTS;
      return {
        result: {
          ok: true,
          pattern,
          count: Math.min(files.length, MAX_RESULTS),
          files: files.slice(0, MAX_RESULTS),
          ...(truncated ? { truncated: `more than ${MAX_RESULTS} matches` } : {}),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
