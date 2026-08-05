import mongoose from 'mongoose';
import { createLogger } from '../../config/logger';
import { ResourceModel, type ResourceDoc } from './resource.model';

// Use mongoose's *bundled* mongodb driver so the GridFS types match `mongoose.connection.db`
// (importing the top-level `mongodb` package yields a second, incompatible copy of the types).
type Bucket = InstanceType<typeof mongoose.mongo.GridFSBucket>;
type DownloadStream = ReturnType<Bucket['openDownloadStream']>;

const log = createLogger('resource-repo');

/** Lazily-bound GridFS bucket over the shared mongoose connection (created on first byte write). */
let bucket: Bucket | null = null;
function getBucket(): Bucket {
  if (bucket) return bucket;
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongo connection is not ready');
  bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'resources' });
  return bucket;
}

function uploadBytes(bytes: Buffer, filename: string, mime: string): Promise<mongoose.mongo.ObjectId> {
  return new Promise((resolve, reject) => {
    const up = getBucket().openUploadStream(filename, { contentType: mime });
    up.on('error', reject);
    up.on('finish', () => resolve(up.id));
    up.end(bytes);
  });
}

function streamToBuffer(stream: DownloadStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export interface StoreResourceInput {
  sessionId: string;
  agentId: string;
  bytes: Buffer;
  kind: 'image' | 'blob';
  mime?: string;
  filename?: string;
  source?: 'attachment' | 'tool' | 'fetch';
  /** Pre-chosen handle (e.g. one preserved across a hop); omit to auto-allocate the next per session. */
  handle?: string;
}

export const resourceRepository = {
  /** Next free handle for a kind in a session: `img_N` / `blob_N`, N = existing count + 1. */
  async nextHandle(sessionId: string, kind: 'image' | 'blob'): Promise<string> {
    const prefix = kind === 'image' ? 'img_' : 'blob_';
    const count = await ResourceModel.countDocuments({ session_id: sessionId, kind });
    return `${prefix}${count + 1}`;
  },

  /**
   * Persist bytes to GridFS + a metadata doc; returns the stored resource (with its handle).
   *
   * Handle allocation is read-then-write (`count + 1`), so two concurrent stores in one session can
   * both pick `img_1`. The unique index catches the loser — and this retries it with a freshly
   * counted handle rather than failing. That matters because parallelism here is normal, not
   * exceptional: a flow renders an image and speaks a line at the same time, and independent nodes
   * are executed concurrently by design. The bytes are uploaded once and reused across attempts;
   * only the cheap metadata insert is repeated.
   */
  async store(input: StoreResourceInput): Promise<ResourceDoc> {
    const mime = input.mime ?? 'application/octet-stream';
    const gridfsId = await uploadBytes(
      input.bytes,
      `${input.sessionId}/${input.handle ?? input.kind}`,
      mime,
    );

    const MAX_ATTEMPTS = 8;
    for (let attempt = 1; ; attempt += 1) {
      const handle = input.handle ?? (await this.nextHandle(input.sessionId, input.kind));
      try {
        const doc = await ResourceModel.create({
          session_id: input.sessionId,
          agent_id: input.agentId,
          handle,
          kind: input.kind,
          mime,
          size: input.bytes.length,
          filename: input.filename ?? '',
          source: input.source ?? 'tool',
          gridfs_id: gridfsId,
        });
        log.debug({ sessionId: input.sessionId, handle, size: input.bytes.length }, 'resource stored');
        return doc;
      } catch (err) {
        const duplicate = (err as { code?: number })?.code === 11000;
        // A caller-pinned handle colliding is a real conflict (the same handle preserved across a
        // hop), not a race — retrying would spin forever on the same value.
        if (!duplicate || input.handle || attempt >= MAX_ATTEMPTS) throw err;
        log.debug({ sessionId: input.sessionId, handle, attempt }, 'handle taken; re-allocating');
      }
    }
  },

  findByHandle(sessionId: string, handle: string): Promise<ResourceDoc | null> {
    return ResourceModel.findOne({ session_id: sessionId, handle }).exec();
  },

  /** All resources in a session, oldest first (matches handle order). Metadata only. */
  listBySession(sessionId: string): Promise<ResourceDoc[]> {
    return ResourceModel.find({ session_id: sessionId }).sort({ created_at: 1 }).exec();
  },

  /** Read a resource's raw bytes by handle (used by `write from_handle`). */
  async readBytes(sessionId: string, handle: string): Promise<Buffer | null> {
    const doc = await this.findByHandle(sessionId, handle);
    if (!doc) return null;
    return streamToBuffer(getBucket().openDownloadStream(doc.gridfs_id));
  },

  /** Open a download stream for a stored resource doc (used by the HTTP content route). */
  openDownload(doc: ResourceDoc): DownloadStream {
    return getBucket().openDownloadStream(doc.gridfs_id);
  },

  /**
   * Open a byte-range stream, for HTTP `Range` requests. `end` is inclusive (as in the HTTP header),
   * while GridFS wants an exclusive bound — that off-by-one is why this wrapper exists rather than
   * callers passing options straight through. Without it a `<video>` can't seek: the player asks for
   * a range, gets the whole file, and scrubbing restarts the download every time.
   */
  openDownloadRange(doc: ResourceDoc, start: number, end: number): DownloadStream {
    return getBucket().openDownloadStream(doc.gridfs_id, { start, end: end + 1 });
  },
};
