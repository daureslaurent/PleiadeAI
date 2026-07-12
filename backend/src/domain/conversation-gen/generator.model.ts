import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** Name of the agent seeded (by migration) as every generator's default interviewer. */
export const DEFAULT_INTERVIEWER_NAME = 'Interviewer';

/**
 * `conversation_generators` — one row per **target agent**: an interviewer agent that periodically
 * strikes up a multi-turn conversation with it, purely to harvest conversations for future SFT
 * training (see `docs/conversation-generator.md`).
 *
 * The generated sessions are ordinary `sessions`/`messages` rows flagged `origin: 'synthetic'`, so
 * they flow into the Conversation Quality Scorer and the fine-tune dataset builder unchanged. Only
 * one generator may target a given agent (`target_agent_id` is unique), so the interval is
 * unambiguous.
 */
const ConversationGeneratorSchema = new Schema(
  {
    /** The agent being interviewed — the one whose answers become training data. */
    target_agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, unique: true },
    /** Denormalised for cheap listing without a populate. */
    target_agent_name: { type: String, required: true },
    /**
     * The agent asking the questions. Defaults to the seeded `Interviewer` but any agent may be
     * pointed at the role. Only its *prompt* is used: the interviewer runs as a single plain
     * inference call (no tools, no memory, no delegation) on the fleet default endpoint+model — the
     * expensive half of a conversation is the target's full run, which is the data we actually want.
     */
    interviewer_agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', required: true },

    /** Off by default: a new generator never starts burning inference until the operator says so. */
    enabled: { type: Boolean, default: false },
    /** Minutes between conversations. */
    interval_minutes: { type: Number, default: 60, min: 1 },
    /** Question→answer exchanges per conversation (the interviewer reads each reply and follows up). */
    turns: { type: Number, default: 3, min: 1, max: 20 },
    /**
     * Optional subjects to steer the interviewer. One is drawn at random per conversation and handed
     * to it as the theme; empty → it invents a subject from the target agent's own charter.
     */
    topics: { type: [String], default: [] },

    last_run_at: { type: Date, default: null },
    /** Last failure message, cleared on the next successful conversation. */
    last_error: { type: String, default: '' },
    /** Lifetime count of conversations this generator has produced. */
    conversations_count: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'conversation_generators',
  },
);

export type ConversationGenerator = InferSchemaType<typeof ConversationGeneratorSchema>;
export type ConversationGeneratorDoc = HydratedDocument<ConversationGenerator>;

export const ConversationGeneratorModel = model('ConversationGenerator', ConversationGeneratorSchema);
