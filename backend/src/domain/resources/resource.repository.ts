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

  /** Persist bytes to GridFS + a metadata doc; returns the stored resource (with its handle). */
  async store(input: StoreResourceInput): Promise<ResourceDoc> {
    const mime = input.mime ?? 'application/octet-stream';
    const handle = input.handle ?? (await this.nextHandle(input.sessionId, input.kind));
    const gridfsId = await uploadBytes(input.bytes, `${input.sessionId}/${handle}`, mime);
    log.debug({ sessionId: input.sessionId, handle, size: input.bytes.length }, 'resource stored');
    return ResourceModel.create({
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
};
