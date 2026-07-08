import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `finetune_servers` collection. Each document is one remote, headless fine-tuning server
 * (the `finetune/` microservice) running on a GPU box. The backend proxies every call to it —
 * `/hardware`, `/usage`, `/upload`, `/train`, `/jobs/:id` — so the credential never reaches the
 * browser.
 *
 * Unlike `endpoints` (which stores `api_key` in plaintext), the bearer token here is encrypted at
 * rest (`api_key_enc`, AES-256-GCM via `isolation/ssh.service`) and `select: false` so it is never
 * returned by a default query — mirroring `domain/isolations/isolation.model.ts`.
 */
const FinetuneServerSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    /** Base URL of the fine-tune service, e.g. `http://192.168.1.30:8088` (no trailing slash). */
    base_url: { type: String, required: true },
    /** AES-256-GCM encrypted bearer token (the server's `FINETUNE_API_KEY`). Never sent to clients. */
    api_key_enc: { type: String, default: null, select: false },
    /** Disabled servers stay configured but are hidden from the FineTuning page + never polled. */
    enabled: { type: Boolean, default: true },
  },
  { collection: 'finetune_servers', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type FinetuneServer = InferSchemaType<typeof FinetuneServerSchema>;
export type FinetuneServerDoc = HydratedDocument<FinetuneServer>;

export const FinetuneServerModel = model('FinetuneServer', FinetuneServerSchema);
