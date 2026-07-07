import type { Tool } from '../../types';
import { resourceRepository } from '../../../domain/resources/resource.repository';
import { fileExists, writeFileBytes, toErrorResult } from './env-fs';

/**
 * `write` — create or overwrite a file with the given contents, matching OpenCode's tool name and
 * argument schema (`filePath`, `content`). Parent directories are created as needed. Pass `from_handle`
 * instead of `content` to write the raw bytes of a resource handle (e.g. a `blob_N` fetched by
 * `webfetch`) straight to disk — the way to persist a binary the agent can't read as text.
 */
export const write: Tool = {
  name: 'write',
  description:
    'Writes a file to the filesystem, creating it (and any missing parent directories) or ' +
    'overwriting it if it exists. Provide the full intended `content` — it replaces the file ' +
    'entirely — or `from_handle` to write the raw bytes of a resource handle (e.g. a `blob_N` from ' +
    'webfetch) to the file. Prefer `edit` for changing part of an existing file.',
  parameters: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'The path of the file to write.' },
      content: { type: 'string', description: 'The full text content to write (omit when using from_handle).' },
      from_handle: {
        type: 'string',
        description: 'A resource handle (e.g. "blob_1") whose raw bytes are written to the file instead of `content`.',
      },
    },
    required: ['filePath'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const filePath = String(args.filePath ?? '').trim();
    if (!filePath) return { result: { ok: false, error: 'filePath is required' } };

    const fromHandle = args.from_handle != null ? String(args.from_handle).trim() : '';

    try {
      // Bytes to write: a resource handle's raw bytes (binary-safe), else the provided text content.
      let bytes: Buffer;
      if (fromHandle) {
        const data = await resourceRepository.readBytes(ctx.sessionId, fromHandle);
        if (!data) {
          return { result: { ok: false, error: `no resource with handle "${fromHandle}" in this session` } };
        }
        bytes = data;
      } else {
        const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
        bytes = Buffer.from(content, 'utf8');
      }

      const existed = await fileExists(ctx, filePath);
      await writeFileBytes(ctx, filePath, bytes);
      return {
        result: {
          ok: true,
          path: filePath,
          action: existed ? 'overwrote' : 'created',
          bytes: bytes.length,
          ...(fromHandle ? { from_handle: fromHandle } : {}),
        },
      };
    } catch (err) {
      return toErrorResult(err);
    }
  },
};
