import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * The write capabilities an API key can be granted. A key with **no** scopes is read-only (the
 * historical default); each scope listed here unlocks the mutating methods on one route family in
 * `auth.ts`. Keep this the single source of truth — the auth guard, the mint route and the UI all
 * validate against it.
 */
export const API_KEY_SCOPES = ['agents:write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * `api_keys` collection. Each document is one long-lived credential handed to an external consumer
 * (a scripted export, an MCP client, …) so it can reach this instance without the operator password
 * or a full-privilege JWT. A key is **read-only unless granted `scopes`** (see {@link API_KEY_SCOPES});
 * scoped writes are still confined to the matching route family and never reach key management.
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
    /** Granted write capabilities (subset of {@link API_KEY_SCOPES}). Empty = read-only. */
    scopes: { type: [String], enum: API_KEY_SCOPES, default: [] },
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
