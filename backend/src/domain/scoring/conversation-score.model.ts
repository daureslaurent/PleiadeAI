import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `conversation_scores` — one Conversation Quality Scorer verdict per turn (keyed by `turn_id`).
 * Re-scoring a turn upserts on `turn_id`. Feeds SFT-dataset triage: filter by `tag` / `score`.
 */
const ConversationScoreSchema = new Schema(
  {
    turn_id: { type: String, required: true, unique: true, index: true },
    session_id: { type: String, default: null, index: true },
    score: { type: Number, required: true, min: 0, max: 100, index: true },
    tag: {
      type: String,
      enum: ['Perfect', 'Patched', 'Recovered', 'Rejected'],
      required: true,
      index: true,
    },
    explanation: { type: String, default: '' },
    /** Judge model that produced this ruling (for auditing / deciding whether to re-score). */
    judge_model: { type: String, default: '' },
    /** How the score was produced. */
    origin: { type: String, enum: ['auto', 'batch', 'manual'], default: 'auto' },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'conversation_scores' },
);

export type ConversationScoreRow = InferSchemaType<typeof ConversationScoreSchema>;
export type ConversationScoreDoc = HydratedDocument<ConversationScoreRow>;

export const ConversationScoreModel = model('ConversationScore', ConversationScoreSchema);
