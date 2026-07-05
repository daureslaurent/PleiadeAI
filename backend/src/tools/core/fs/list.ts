import type { Tool } from '../../types';
import { runInEnv, shq, toErrorResult } from './env-fs';

const MAX_ENTRIES = 500;
/** Always-pruned noise directories, plus whatever the caller adds via `ignore`. */
const DEFAULT_PRUNE = ['node_modules', '.git', 'dist', '.next', 'build', '__pycache__'];

/**
 * `list` — list files and directories under a path, matching OpenCode's tool name and argument
 * schema (`path`, `ignore`). Returns a depth-limited tree with noise directories pruned.
 */
export const list: Tool = {
  name: 'list',
  description:
    'Lists files and directories under a path (default: current directory), pruning common noise ' +
    'directories. Pass `ignore` (an array of directory names) to prune more.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The directory to list (default: current directory).' },
      ignore: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional directory names to prune from the listing.',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const path = String(args.path ?? '.').trim() || '.';
    const extra = Array.isArray(args.ignore) ? args.ignore.map(String) : [];
    const pruneNames = [...new Set([...DEFAULT_PRUNE, ...extra])];
    const pruneExpr = pruneNames.map((n) => `-name ${shq(n)}`).join(' -o ');

    // Depth-limited find: prune noise dirs, print dirs with a trailing slash, files bare.
    const command =
      `find ${shq(path)} -maxdepth 4 \\( ${pruneExpr} \\) -prune -o -print 2>&1 | head -n ${MAX_ENTRIES + 1}`;

    try {
      const r = await runInEnv(ctx, command);
      if (r.exitCode !== 0 && !r.stdout.trim()) {
        return { result: { ok: false, error: r.stderr.trim() || r.stdout.trim() || 'list failed' } };
      }
      const lines = r.stdout.split('\n').filter(Boolean);
      const truncated = lines.length > MAX_ENTRIES;
      return {
        result: {
          ok: true,
          path,
          count: Math.min(lines.length, MAX_ENTRIES),
          output: lines.slice(0, MAX_ENTRIES).join('\n'),
          ...(truncated ? { truncated: `more than ${MAX_ENTRIES} entries` } : {}),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
