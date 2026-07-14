import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `mail_accounts` collection (see `GMAIL_TOOL_PLAN.md`). One document per Google mailbox the
 * operator has linked via OAuth on Settings → Connections. Agents are granted access per account
 * (`agent.mail_accounts` holds the ids) and read it through the `list_mail`/`read_mail` tools —
 * strictly read-only (`gmail.readonly` scope): the tools never call `messages.modify`, so reading
 * never marks anything read in the origin mailbox.
 *
 * The refresh token is AES-256-GCM encrypted at rest (`isolation/ssh.service` helper) and
 * `select: false`, mirroring `finetune-server.model.ts` — it never leaves the backend and the
 * `_enc` suffix keeps it inside `redact.ts`'s secret pattern as a second line of defence.
 */
const MailAccountSchema = new Schema(
  {
    /** The mailbox address, as reported by Gmail's own profile endpoint after consent. */
    email: { type: String, required: true, unique: true, trim: true },
    provider: { type: String, enum: ['google'], default: 'google' },
    /** AES-256-GCM encrypted OAuth refresh token. Never sent to clients. */
    refresh_token_enc: { type: String, required: true, select: false },
    /** OAuth scopes actually granted at consent time (space-separated, as Google returns them). */
    scopes: { type: String, default: '' },
    /**
     * `linked` — refresh token believed good; `error` — the last Gmail call failed to authenticate
     * (revoked consent, deleted OAuth client…), surfaced on Settings → Connections with `last_error`.
     * Re-linking the same address overwrites the token and resets the status.
     */
    status: { type: String, enum: ['linked', 'error'], default: 'linked' },
    last_error: { type: String, default: '' },
  },
  { collection: 'mail_accounts', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type MailAccount = InferSchemaType<typeof MailAccountSchema>;
export type MailAccountDoc = HydratedDocument<MailAccount>;

export const MailAccountModel = model('MailAccount', MailAccountSchema);
