import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `resources` collection — persisted, session-scoped resources an agent references by **handle**.
 *
 * Generalizes the old per-turn, in-memory image pool: a resource is either an **image** (handle
 * `img_N`, foldable into a multimodal model's context) or an opaque **blob** (handle `blob_N`, e.g. a
 * PDF/archive fetched by `webfetch` — never enters context, only reachable by handle). The raw bytes
 * live in a GridFS bucket (`resources`) via `gridfs_id`; this doc holds only the metadata. Persistence
 * (vs the old in-memory pool) is what lets a handle survive across turns and cross-agent hops, be
 * written to a file (`write from_handle`), and be listed in the workspace Data tab.
 */
const ResourceSchema = new Schema(
  {
    /** Chat session the resource belongs to (matches `ToolContext.sessionId`). */
    session_id: { type: String, required: true, index: true },
    /** Agent that acquired it (matches `ToolContext.agentId`). */
    agent_id: { type: String, required: true },
    /** Stable per-session handle: `img_N` for images, `blob_N` for blobs. */
    handle: { type: String, required: true },
    kind: { type: String, enum: ['image', 'blob'], required: true },
    mime: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    /** Suggested filename for download (from the URL / Content-Disposition). */
    filename: { type: String, default: '' },
    source: { type: String, enum: ['attachment', 'tool', 'fetch'], default: 'tool' },
    /** GridFS file id holding the raw bytes. */
    gridfs_id: { type: Schema.Types.ObjectId, required: true },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'resources' },
);

// One handle per session; the pool allocates sequentially so this also guards against races.
ResourceSchema.index({ session_id: 1, handle: 1 }, { unique: true });

export type Resource = InferSchemaType<typeof ResourceSchema>;
export type ResourceDoc = HydratedDocument<Resource>;

export const ResourceModel = model('Resource', ResourceSchema);
