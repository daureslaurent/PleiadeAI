import { createLogger } from '../../config/logger';
import { resourceRepository } from '../../domain/resources/resource.repository';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { Tool } from '../types';
import { readFileBytes, writeFileBytes, toErrorResult } from './fs/env-fs';

const log = createLogger('tool:data');

/**
 * `data` — the agent's window onto the session's persisted **resource pool** (images + binary blobs,
 * each with a stable `img_N` / `blob_N` handle). Resources are **session-scoped**: they survive across
 * turns and are shared by every agent in the session, so handing a file to another agent is just
 * naming its handle in the delegation — the delegate reaches it with `data` too, no file paths.
 *
 * Actions:
 * - `list`   — enumerate the session's resources (handle, kind, mime, size, filename).
 * - `save`   — write a resource handle's raw bytes to a file in the workspace (materialise a blob).
 * - `store`  — save a workspace file (or inline text) as a new blob resource, returning its handle.
 */
export const data: Tool = {
  name: 'data',
  description:
    "Manage the session's saved resources (images and binary files) by handle (e.g. blob_1, img_2). " +
    'Resources persist for the whole session and are shared across agents, so to give a file to ' +
    'another agent, just mention its handle when you delegate — it can read it with `data` too. ' +
    "Actions: 'list' (see every resource), 'save' (write a handle's bytes to a file: needs `handle` " +
    "+ `path`), 'store' (save a workspace file or text as a new resource: needs `path` or `content`).",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'save', 'store'], description: 'What to do.' },
      handle: { type: 'string', description: 'Resource handle for `save` (e.g. "blob_1").' },
      path: {
        type: 'string',
        description: 'For `save`: the destination file path. For `store`: the source file to save as a resource.',
      },
      content: { type: 'string', description: 'For `store`: inline text to save (alternative to `path`).' },
      filename: { type: 'string', description: 'For `store`: a suggested name for the stored resource.' },
      mime: { type: 'string', description: 'For `store`: MIME type (default application/octet-stream).' },
    },
    required: ['action'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const action = String(args.action ?? '').trim();

    if (action === 'list') {
      const rows = await resourceRepository.listBySession(ctx.sessionId);
      return {
        result: {
          ok: true,
          count: rows.length,
          resources: rows.map((r) => ({
            handle: r.handle,
            kind: r.kind,
            mime: r.mime,
            size: r.size,
            filename: r.filename || undefined,
            source: r.source,
          })),
        },
      };
    }

    if (action === 'save') {
      const handle = String(args.handle ?? '').trim();
      const path = String(args.path ?? '').trim();
      if (!handle) return { result: { ok: false, error: 'handle is required for save' } };
      if (!path) return { result: { ok: false, error: 'path is required for save' } };
      try {
        const bytes = await resourceRepository.readBytes(ctx.sessionId, handle);
        if (!bytes) {
          return { result: { ok: false, error: `no resource with handle "${handle}" in this session` } };
        }
        await writeFileBytes(ctx, path, bytes);
        log.info({ agent: ctx.agentName, handle, path, bytes: bytes.length }, 'data save');
        return { result: { ok: true, handle, path, bytes: bytes.length } };
      } catch (err) {
        return toErrorResult(err);
      }
    }

    if (action === 'store') {
      const path = args.path != null ? String(args.path).trim() : '';
      const content = typeof args.content === 'string' ? args.content : '';
      if (!path && !content) {
        return { result: { ok: false, error: 'store needs either `path` (a file) or `content` (text)' } };
      }
      try {
        const bytes = path ? await readFileBytes(ctx, path) : Buffer.from(content, 'utf8');
        const filename =
          (args.filename != null && String(args.filename).trim()) ||
          (path ? path.split('/').filter(Boolean).pop() : '') ||
          'resource';
        const mime = args.mime != null && String(args.mime).trim()
          ? String(args.mime).trim()
          : 'application/octet-stream';
        const stored = await resourceRepository.store({
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          bytes,
          kind: 'blob',
          mime,
          filename,
          source: 'tool',
        });
        // Return the block so the runner adopts it into this turn's pool (storageId set → not re-stored).
        const block: ImageBlock = {
          id: stored.handle,
          kind: 'blob',
          mime,
          size: bytes.length,
          filename,
          storageId: String(stored.gridfs_id),
          source: 'tool',
        };
        log.info({ agent: ctx.agentName, handle: stored.handle, bytes: bytes.length }, 'data store');
        return {
          result: { ok: true, handle: stored.handle, kind: 'blob', mime, size: bytes.length, filename },
          resources: [block],
        };
      } catch (err) {
        return toErrorResult(err);
      }
    }

    return { result: { ok: false, error: `unknown action: ${action || '(empty)'}` } };
  },
};
