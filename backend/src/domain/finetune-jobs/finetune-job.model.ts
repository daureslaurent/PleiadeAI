import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** Lifecycle mirrors the remote service's job phases. Terminal: `done` | `failed`. */
export const FINETUNE_JOB_STATUSES = [
  'queued',
  'preparing',
  'training',
  'exporting',
  'done',
  'failed',
] as const;

export type FinetuneJobStatus = (typeof FINETUNE_JOB_STATUSES)[number];

/** Terminal states — the poller stops tracking these. */
export const TERMINAL_STATUSES: readonly FinetuneJobStatus[] = ['done', 'failed'];

const TrainMetricSchema = new Schema(
  {
    step: { type: Number, required: true },
    loss: { type: Number, required: true },
    epoch: { type: Number, default: null },
    lr: { type: Number, default: null },
    at: { type: String, required: true },
  },
  { _id: false },
);

/**
 * `finetune_jobs` collection. The **durable** record of a training run kicked off on a remote
 * fine-tune server. The remote service keeps job state in memory only (v1), so this document —
 * kept fresh by `finetune/poller.ts` — is what the UI reads and what survives a restart on
 * either side.
 */
const FinetuneJobSchema = new Schema(
  {
    /** The `finetune_servers` document this run lives on. */
    server_id: { type: Schema.Types.ObjectId, ref: 'FinetuneServer', required: true, index: true },
    /** Job id assigned by the remote service (what we poll). */
    remote_job_id: { type: String, required: true, index: true },

    run_name: { type: String, required: true },
    base_model: { type: String, required: true },
    /** Parameter count (billions) resolved by the remote pre-flight. */
    size_b: { type: Number, default: null },
    strategy: { type: String, default: '' },
    /** Snapshot of the remote's fitted training plan (feasibility, adjustments, warnings). */
    plan: { type: Schema.Types.Mixed, default: null },

    /** Where the training data came from, and a snapshot of its composition at launch. */
    dataset_source: { type: String, enum: ['scored', 'manual'], required: true },
    dataset_stats: { type: Schema.Types.Mixed, default: null },

    status: { type: String, enum: FINETUNE_JOB_STATUSES, default: 'queued', index: true },
    /** 0..1, mirrored from the remote job. */
    progress: { type: Number, default: 0 },
    /** Loss curve, appended as the poller observes new datapoints. */
    metrics: { type: [TrainMetricSchema], default: [] },
    /** Most recent remote log lines, for the UI's live log tail. */
    log_tail: { type: [String], default: [] },

    gguf_filename: { type: String, default: '' },
    error: { type: String, default: '' },
    finished_at: { type: Date, default: null },
  },
  { collection: 'finetune_jobs', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type FinetuneJob = InferSchemaType<typeof FinetuneJobSchema>;
export type FinetuneJobDoc = HydratedDocument<FinetuneJob>;

export const FinetuneJobModel = model('FinetuneJob', FinetuneJobSchema);
