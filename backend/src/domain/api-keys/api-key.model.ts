import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `api_keys` collection. Each document is one long-lived, **read-only** credential handed to an
 * external consumer (a scripted export, an MCP client, …) so it can pull data from this instance
 * without the operator password or a full-privilege JWT.
 *
 * The secret itself is never stored: only `prefix` (the public lookup handle, printed in the UI)
 * and `key_hash` = sha256(full key). `key_hash` is `select: false` so no default query returns it —
 * mirroring `finetune-server.model.ts`. See `api-key.service.ts` for the format and verification.
 */
const ApiKeySchema = new Schema(
  {
    /** Operator-facing label, e.g. "claude-code". Not unique — names are for humans. */
    name: { type: String, required: true, trim: true },
    /** Public, indexed handle (the `plk_<prefix>` part). Identifies which row to hash-check. */
    prefix: { type: String, required: true, unique: true },
    /** sha256 hex of the whole presented key. Compared timing-safely; never returned to a client. */
    key_hash: { type: String, required: true, select: false },
    /** Touched (throttled) on each authenticated request, so the UI can show liveness. */
    last_used_at: { type: Date, default: null },
    /** Set on revoke. A revoked key fails verification but keeps its row for audit. */
    revoked_at: { type: Date, default: null },
  },
  { collection: 'api_keys', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type ApiKey = InferSchemaType<typeof ApiKeySchema>;
export type ApiKeyDoc = HydratedDocument<ApiKey>;

export const ApiKeyModel = model('ApiKey', ApiKeySchema);
