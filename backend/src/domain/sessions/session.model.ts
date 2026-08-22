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
     *
     * `forum` marks a session spawned by the operator running an @-mention (`FORUM_PLAN.md` §11.3).
     * It is a real conversation in every other respect — same tools, same streaming, same scoring —
     * which is the whole point of reusing sessions for it: the operator can keep talking after the
     * agent's answer has gone back to the thread.
     */
    origin: { type: String, enum: ['user', 'synthetic', 'forum'], default: 'user', index: true },
    /** Synthetic only: the `conversation_generators` row that produced this session. */
    generator_id: { type: Schema.Types.ObjectId, ref: 'ConversationGenerator', default: null, index: true },
    /**
     * Forum-origin only: the thread the mention came from, and the mention itself. Kept so the
     * Workspace can offer a link back to the board — a mention run read out of context ("who asked
     * this?") is exactly the trace that makes it hard to trust.
     */
    forum_thread_id: { type: Schema.Types.ObjectId, ref: 'ForumThread', default: null },
    forum_mention_id: { type: Schema.Types.ObjectId, ref: 'ForumMention', default: null },
    /**
     * Forum-origin only: this run answers a mention, but it does not *continue* that mention's chain
     * — anything it summons starts again from depth zero (`FORUM_AUTORUN_PLAN.md`).
     *
     * Set when a run was started by the operator's Run button or by the sweeper. Neither is a reply
     * to anybody, which is precisely the condition §11.7 already gives for a chain root; a cron job
     * and an auto-mode tick have always been treated the same way. Without it a swept relay would
     * inherit whatever depth it happened to be found at and die four hand-offs later, mid-project.
     *
     * A flag on the session rather than on the mention because the mention *records what happened*
     * — its `chain_depth` is the depth it was written at, and rewriting that to suit the run reading
     * it would falsify the history the guard is judged against.
     */
    forum_chain_reset: { type: Boolean, default: false },
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
