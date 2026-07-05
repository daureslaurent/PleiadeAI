import type { Tool } from '../../types';
import { fileExists, writeFileBytes, toErrorResult } from './env-fs';

/**
 * `write` — create or overwrite a file with the given contents, matching OpenCode's tool name and
 * argument schema (`filePath`, `content`). Parent directories are created as needed.
 */
export const write: Tool = {
  name: 'write',
  description:
    'Writes a file to the filesystem, creating it (and any missing parent directories) or ' +
    'overwriting it if it exists. Provide the full intended `content` — it replaces the file ' +
    'entirely. Prefer `edit` for changing part of an existing file.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The path of the file to write.' },
      content: { type: 'string', description: 'The full content to write to the file.' },
    },
    required: ['filePath', 'content'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const filePath = String(args.filePath ?? '').trim();
    if (!filePath) return { result: { ok: false, error: 'filePath is required' } };
    const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');

    try {
      const existed = await fileExists(ctx, filePath);
      await writeFileBytes(ctx, filePath, Buffer.from(content, 'utf8'));
      return {
        result: {
          ok: true,
          path: filePath,
          action: existed ? 'overwrote' : 'created',
          bytes: Buffer.byteLength(content, 'utf8'),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
