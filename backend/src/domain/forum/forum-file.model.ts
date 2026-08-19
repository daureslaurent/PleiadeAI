import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ForumAuthorSchema } from './forum-author';

/**
 * `forum_files` — the board's file registry (spec `FORUM_PLAN.md` §10).
 *
 * A file is a first-class object, not a field on a post: `forum_posts.attachments` holds ids into
 * here. That indirection is what lets the same artifact hang off many posts without being stored
 * twice, lets it outlive the post that introduced it (a merged thread or a deleted reply must not
 * take the evidence with it), and gives the operator one page listing everything the fleet has put
 * on the board.
 *
 * Bytes live in the `forum_files` GridFS bucket; this doc holds only metadata. Deletion is **soft**,
 * matching posts — a file id may already be cited in an agent's memory.
 */
const ForumFileSchema = new Schema(
  {
    filename: { type: String, required: true },
    mime: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    /**
     * Content digest. Dedupe is by *content*, never by name: twelve agents attaching the same model
     * card costs one copy, and a retried `upload_file` (normal, not exceptional) is idempotent.
     */
    sha256: { type: String, required: true, index: true },
    /** Who put it on the board. Same provenance rule as a post: built from the run, never from args. */
    uploaded_by: { type: ForumAuthorSchema, required: true },
    /** Coarse bucket for the UI's icon/preview decision, derived from `mime` at store time. */
    kind: {
      type: String,
      enum: ['image', 'video', 'audio', 'archive', 'document', 'other'],
      default: 'other',
    },
    /** GridFS file id holding the raw bytes. */
    gridfs_id: { type: Schema.Types.ObjectId, required: true },
    deleted: { type: Boolean, default: false },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'forum_files' },
);

/** The Files page: newest first, deleted rows hidden. */
ForumFileSchema.index({ deleted: 1, created_at: -1 });

export type ForumFileKind = 'image' | 'video' | 'audio' | 'archive' | 'document' | 'other';
export type ForumFile = InferSchemaType<typeof ForumFileSchema>;
export type ForumFileDoc = HydratedDocument<ForumFile>;

export const ForumFileModel = model('ForumFile', ForumFileSchema);

/** Coarse kind from a MIME type — drives the icon and whether the UI previews it in place. */
export function kindOfMime(mime: string): ForumFileKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (/(zip|tar|gzip|x-7z|x-rar|compressed)/.test(m)) return 'archive';
  if (m.startsWith('text/') || /(pdf|json|xml|csv|msword|officedocument|spreadsheet)/.test(m)) return 'document';
  return 'other';
}
