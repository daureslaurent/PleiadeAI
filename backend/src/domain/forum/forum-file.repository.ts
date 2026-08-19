import { createHash } from 'crypto';
import mongoose, { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { ForumFileModel, kindOfMime, type ForumFileDoc } from './forum-file.model';
import { ForumPostModel } from './forum-post.model';
import type { ForumAuthor } from './forum-author';

// Mongoose's *bundled* mongodb driver, so the GridFS types match `mongoose.connection.db` (importing
// the top-level `mongodb` package yields a second, incompatible copy of the types).
type Bucket = InstanceType<typeof mongoose.mongo.GridFSBucket>;
type DownloadStream = ReturnType<Bucket['openDownloadStream']>;

const log = createLogger('forum-files');

/** Lazily-bound GridFS bucket over the shared mongoose connection (created on first byte write). */
let bucket: Bucket | null = null;
function getBucket(): Bucket {
  if (bucket) return bucket;
  const db = mongoose.connection.db;
  if (!db) throw new Error('mongo connection is not ready');
  bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'forum_files' });
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

export interface StoreForumFileInput {
  bytes: Buffer;
  filename: string;
  mime?: string;
  uploadedBy: ForumAuthor;
}

export interface ForumFileUsage {
  postId: string;
  threadId: string;
  threadTitle: string;
  author: string;
  createdAt: Date;
}

export const forumFileRepository = {
  /**
   * Store bytes and return the registry entry — reusing an existing, non-deleted file with the same
   * sha256 rather than writing a second copy. Dedupe is by content and deliberately ignores the
   * name: the *same* bytes uploaded as `run.log` and `run-2.log` are one file with whichever name
   * arrived first, which is the behaviour that makes a retried tool call idempotent.
   */
  async store(input: StoreForumFileInput): Promise<{ file: ForumFileDoc; deduped: boolean }> {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const existing = await ForumFileModel.findOne({ sha256, deleted: false }).exec();
    if (existing) {
      log.debug({ sha256, fileId: String(existing._id) }, 'forum file deduped');
      return { file: existing, deduped: true };
    }

    const mime = input.mime?.trim() || 'application/octet-stream';
    const filename = input.filename.trim() || 'file';
    const gridfsId = await uploadBytes(input.bytes, filename, mime);
    const file = await ForumFileModel.create({
      filename,
      mime,
      size: input.bytes.length,
      sha256,
      uploaded_by: input.uploadedBy,
      kind: kindOfMime(mime),
      gridfs_id: gridfsId,
    });
    log.info(
      { fileId: String(file._id), filename, size: input.bytes.length, by: input.uploadedBy.display_name },
      'forum file stored',
    );
    return { file, deduped: false };
  },

  findById(id: string): Promise<ForumFileDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return ForumFileModel.findOne({ _id: id, deleted: false }).exec();
  },

  /** Resolve a set of ids in one query, preserving the caller's order (attachment order is authored). */
  async findByIds(ids: Array<string | Types.ObjectId>): Promise<ForumFileDoc[]> {
    const valid = ids.map(String).filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return [];
    const docs = await ForumFileModel.find({ _id: { $in: valid }, deleted: false }).exec();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return valid.map((id) => byId.get(id)).filter((d): d is ForumFileDoc => Boolean(d));
  },

  /** Registry listing for the Files page / `list_files`. `q` is a case-insensitive filename match. */
  list(opts: { q?: string; kind?: string; limit?: number } = {}): Promise<ForumFileDoc[]> {
    const filter: Record<string, unknown> = { deleted: false };
    if (opts.q?.trim()) filter.filename = { $regex: opts.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (opts.kind) filter.kind = opts.kind;
    return ForumFileModel.find(filter)
      .sort({ created_at: -1 })
      .limit(Math.max(1, Math.min(500, Math.trunc(opts.limit ?? 100) || 100)))
      .exec();
  },

  /** Every post that attaches a file — the "what references this" column on the Files page. */
  async usage(fileId: string): Promise<ForumFileUsage[]> {
    if (!Types.ObjectId.isValid(fileId)) return [];
    const posts = await ForumPostModel.find({ attachments: fileId, deleted: false })
      .populate<{ thread_id: { _id: Types.ObjectId; title?: string } }>('thread_id', 'title')
      .sort({ created_at: -1 })
      .limit(50)
      .exec();
    return posts.map((p) => {
      const thread = p.thread_id as unknown as { _id: Types.ObjectId; title?: string };
      return {
        postId: String(p._id),
        threadId: String(thread?._id ?? p.thread_id),
        threadTitle: thread?.title ?? '(thread)',
        author: p.author.display_name,
        createdAt: p.created_at,
      };
    });
  },

  /** Reference count across live posts, for the listing (cheap enough as one aggregation). */
  async usageCounts(fileIds: Array<string | Types.ObjectId>): Promise<Record<string, number>> {
    const ids = fileIds.map(String).filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length) return {};
    const rows = await ForumPostModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { attachments: { $in: ids.map((id) => new Types.ObjectId(id)) }, deleted: false } },
      { $unwind: '$attachments' },
      { $match: { attachments: { $in: ids.map((id) => new Types.ObjectId(id)) } } },
      { $group: { _id: '$attachments', n: { $sum: 1 } } },
    ]).exec();
    return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
  },

  /**
   * Soft-delete a file and detach it from every post that carries it. Detaching matters: a post left
   * pointing at a deleted file would render a chip that 404s, and `get_attachment` would hand an
   * agent an id it can never read.
   */
  async remove(fileId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(fileId)) return false;
    const res = await ForumFileModel.updateOne({ _id: fileId, deleted: false }, { $set: { deleted: true } }).exec();
    if (!res.matchedCount) return false;
    await ForumPostModel.updateMany({ attachments: fileId }, { $pull: { attachments: fileId } }).exec();
    log.info({ fileId }, 'forum file deleted');
    return true;
  },

  /** Detach one file from one post, leaving the file in the registry (the moderator's soft verb). */
  async detach(postId: string, fileId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(postId) || !Types.ObjectId.isValid(fileId)) return false;
    const res = await ForumPostModel.updateOne({ _id: postId }, { $pull: { attachments: fileId } }).exec();
    return res.modifiedCount > 0;
  },

  async readBytes(fileId: string): Promise<Buffer | null> {
    const doc = await this.findById(fileId);
    if (!doc) return null;
    return streamToBuffer(getBucket().openDownloadStream(doc.gridfs_id));
  },

  openDownload(doc: ForumFileDoc): DownloadStream {
    return getBucket().openDownloadStream(doc.gridfs_id);
  },

  /** Byte-range stream for HTTP `Range` (`end` inclusive here, exclusive in GridFS) — video seeking. */
  openDownloadRange(doc: ForumFileDoc, start: number, end: number): DownloadStream {
    return getBucket().openDownloadStream(doc.gridfs_id, { start, end: end + 1 });
  },
};
