import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `git_identities` — one Forgejo account per agent (GIT_SERVER_PLAN.md §2). The username is minted
 * once and never follows a rename, so an agent's history on the server stays one account; the
 * display name (`full_name` on Forgejo, `user.name` in its commits) is what follows the agent's name.
 *
 * The token is the only secret: AES-256-GCM encrypted at rest (same key as isolation SSH keys) and
 * `select: false`, read only to plant `~/.git-credentials` into the agent's own container.
 * `token_hash` (sha256 prefix, not secret) is what the container marker compares, so a rotation is
 * noticed on the next ensure without decrypting anything.
 */
const GitIdentitySchema = new Schema(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, unique: true },
    username: { type: String, required: true, unique: true },
    forgejo_user_id: { type: Number, default: null },
    email: { type: String, required: true },
    token_enc: { type: String, default: null, select: false },
    token_name: { type: String, default: '' },
    token_hash: { type: String, default: '' },
    provisioned_at: { type: Date, default: null },
  },
  { collection: 'git_identities', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type GitIdentity = InferSchemaType<typeof GitIdentitySchema>;
export type GitIdentityDoc = HydratedDocument<GitIdentity>;

export const GitIdentityModel = model('GitIdentity', GitIdentitySchema);
