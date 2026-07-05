import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `messages` collection: one persisted turn in a session. The rich `blocks` (interleaved prose +
 * tool invocations), `reasoning` (`<think>`), and per-turn `trace` are stored verbatim as the UI
 * assembles them from the live stream, so reloading a session reconstructs the chat *and* the
 * debugger exactly. `text` is the plain-text projection used for the model's history context.
 */
const MessageSchema = new Schema(
  {
    session_id: { type: Schema.Types.ObjectId, ref: 'Session', required: true, index: true },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, default: '' },
    /** Assistant only: ordered prose/tool blocks exactly as rendered. */
    blocks: { type: Schema.Types.Mixed, default: undefined },
    /** Assistant only: reasoning stream for this turn. */
    reasoning: { type: String, default: undefined },
    /** Assistant only: debugger trace entries produced during this turn. */
    trace: { type: Schema.Types.Mixed, default: undefined },
    /** Assistant only: session context size (prompt tokens) after this turn, for the chat header. */
    context_tokens: { type: Number, default: undefined },
    /** Assistant only: model context window at the time, so the header can show a fraction. */
    context_window: { type: Number, default: undefined },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'messages',
  },
);

export type Message = InferSchemaType<typeof MessageSchema>;
export type MessageDoc = HydratedDocument<Message>;

export const MessageModel = model('Message', MessageSchema);
