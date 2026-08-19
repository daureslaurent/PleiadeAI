import { Schema, model, Types, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** `notifications` collection (spec §3) — the persistent UI inbox leg of the dual-alert pipeline. */
const NotificationSchema = new Schema(
  {
    /**
     * The agent whose headless task raised this alert. `null` for system-level notifications that
     * belong to no agent (e.g. a remote fine-tune job finishing) — those still show in the
     * unscoped inbox, since every `agent_id` filter is applied only when one is supplied.
     */
    agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', default: null, index: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: String, enum: ['unread', 'read'], default: 'unread', index: true },
    /**
     * What this notification is *about*, when it is about a specific object the UI can act on.
     * `''` — an ordinary text alert (a finished headless task), which is all this collection carried
     * before. `forum_mention` — somebody was @-mentioned (`FORUM_PLAN.md` §11.4), and `ref_id` is the
     * `forum_mentions` row, so the inbox row can offer Run without the operator opening the board.
     */
    kind: { type: String, default: '' },
    ref_id: { type: String, default: '' },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'notifications' },
);

export type Notification = InferSchemaType<typeof NotificationSchema>;
export type NotificationDoc = HydratedDocument<Notification>;

export const NotificationModel = model('Notification', NotificationSchema);
export { Types as MongoTypes };
