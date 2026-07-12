import { Schema, model, Types, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `sessions` collection: one persisted conversation thread between the user and a single agent.
 * Sessions are listed per-agent in the Workspace and survive reloads. The `title` is auto-derived
 * from the first user message (see the message route) and can be renamed.
 */
const SessionSchema = new Schema(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, index: true },
    /** Denormalised for cheap listing without a populate. */
    agent_name: { type: String, required: true },
    title: { type: String, default: 'New session' },
    /**
     * True while the title is machine-generated (auto-titler may refine it as the chat grows).
     * A manual rename flips this to `false`, freezing the title against further auto-updates.
     */
    title_auto: { type: Boolean, default: true },
    /**
     * Who the "user" side of this conversation was. `synthetic` marks a session produced by the
     * Conversation Generator (an interviewer agent talking to this one to harvest training data —
     * see `docs/conversation-generator.md`). The Workspace shows both, marking the generated ones so
     * the interviewer's turns are never mistaken for the operator's; everything else (scoring, the
     * fine-tune dataset builder) treats them alike.
     */
    origin: { type: String, enum: ['user', 'synthetic'], default: 'user', index: true },
    /** Synthetic only: the `conversation_generators` row that produced this session. */
    generator_id: { type: Schema.Types.ObjectId, ref: 'ConversationGenerator', default: null, index: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'sessions',
  },
);

export type Session = InferSchemaType<typeof SessionSchema>;
export type SessionDoc = HydratedDocument<Session>;

export const SessionModel = model('Session', SessionSchema);
export { Types };
