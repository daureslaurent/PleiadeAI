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
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'notifications' },
);

export type Notification = InferSchemaType<typeof NotificationSchema>;
export type NotificationDoc = HydratedDocument<Notification>;

export const NotificationModel = model('Notification', NotificationSchema);
export { Types as MongoTypes };
