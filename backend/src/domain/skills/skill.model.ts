import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export type SkillLanguage = 'ts' | 'py';

/**
 * `skills` collection — dynamic TypeScript/Python scripts (spec §3). Source lives in Mongo
 * and is transpiled/spawned JIT by the sandbox (Step 5). `enabled` is the durable circuit-breaker
 * flag: when a skill trips, it is set `false` here so it stays disabled across process restarts.
 */
const SkillSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    language: { type: String, enum: ['ts', 'py'], required: true },
    /** Raw skill source (TS or Python). Transpiled in-memory (TS) / piped to stdin (Py). */
    source: { type: String, required: true },
    /**
     * JSON-schema describing the skill's arguments, surfaced to the LLM as the tool's
     * parameters. Stored loosely so the Matrix editor can author it freely.
     */
    parameters_schema: { type: Schema.Types.Mixed, default: {} },
    enabled: { type: Boolean, default: true, index: true },
    /** Populated when the circuit breaker trips, for the UI + audit. */
    disabled_reason: { type: String, default: null },
    failure_count: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'skills',
  },
);

export type Skill = InferSchemaType<typeof SkillSchema>;
export type SkillDoc = HydratedDocument<Skill>;

export const SkillModel = model('Skill', SkillSchema);
