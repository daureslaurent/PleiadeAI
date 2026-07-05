import type { Tool } from '../../types';
import { readFileBytes, toErrorResult } from './env-fs';

/** OpenCode `read` defaults: read at most this many lines per call, truncate over-long lines. */
const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/**
 * `read` — read a file from the agent's environment, matching OpenCode's tool name and argument
 * schema (`filePath`, `offset`, `limit`) so OpenCode-tuned models emit compatible calls. Text is
 * returned with 1-based, zero-padded line numbers; image files are returned as an image block.
 */
export const read: Tool = {
  name: 'read',
  description:
    'Reads a file from the filesystem. `filePath` is the path to read. Optionally page through a ' +
    'large file with `offset` (0-based start line) and `limit` (max lines). Text is returned with ' +
    'line numbers; image files are returned inline.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The path of the file to read.' },
      offset: { type: 'number', description: 'The line number to start reading from (0-based).' },
      limit: { type: 'number', description: 'The number of lines to read (default 2000).' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const filePath = String(args.filePath ?? '').trim();
    if (!filePath) return { result: { ok: false, error: 'filePath is required' } };

    try {
      const bytes = await readFileBytes(ctx, filePath);

      const imgExt = IMAGE_EXT.exec(filePath)?.[1]?.toLowerCase();
      if (imgExt) {
        const mime = IMAGE_MIME[imgExt] ?? 'image/png';
        return {
          result: { ok: true, path: filePath, type: 'image' },
          images: [{ dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }],
        };
      }

      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.max(1, Number(args.limit) || DEFAULT_LIMIT);
      const allLines = bytes.toString('utf8').split('\n');
      const slice = allLines.slice(offset, offset + limit);

      const body = slice
        .map((line, i) => {
          const n = String(offset + i + 1).padStart(5, '0');
          const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
          return `${n}| ${text}`;
        })
        .join('\n');

      const more = offset + limit < allLines.length;
      return {
        result: {
          ok: true,
          path: filePath,
          total_lines: allLines.length,
          output: body,
          ...(more ? { truncated: `showing lines ${offset + 1}-${offset + slice.length}` } : {}),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
