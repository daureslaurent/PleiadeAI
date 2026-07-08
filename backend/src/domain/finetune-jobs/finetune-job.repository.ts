import { Types } from 'mongoose';
import {
  FinetuneJobModel,
  TERMINAL_STATUSES,
  type FinetuneJobDoc,
  type FinetuneJobStatus,
} from './finetune-job.model';

/** Cap the persisted loss curve so a long run can't grow the document past Mongo's 16MB limit. */
const METRICS_MAX = 2000;

/** Data-access for tracked fine-tune jobs. The poller owns most writes. */
export const finetuneJobRepository = {
  list(limit = 50): Promise<FinetuneJobDoc[]> {
    return FinetuneJobModel.find().sort({ created_at: -1 }).limit(limit).exec();
  },

  findById(id: string | Types.ObjectId): Promise<FinetuneJobDoc | null> {
    return FinetuneJobModel.findById(id).exec();
  },

  /** Non-terminal jobs — the working set the poller refreshes each tick. */
  findActive(): Promise<FinetuneJobDoc[]> {
    return FinetuneJobModel.find({ status: { $nin: TERMINAL_STATUSES } }).exec();
  },

  create(input: {
    server_id: Types.ObjectId | string;
    remote_job_id: string;
    run_name: string;
    base_model: string;
    size_b?: number | null;
    strategy?: string;
    plan?: unknown;
    dataset_source: 'scored' | 'manual';
    dataset_stats?: unknown;
    status?: FinetuneJobStatus;
  }): Promise<FinetuneJobDoc> {
    return FinetuneJobModel.create(input);
  },

  update(
    id: string | Types.ObjectId,
    patch: Record<string, unknown>,
  ): Promise<FinetuneJobDoc | null> {
    return FinetuneJobModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  /**
   * Replace the persisted metric series with the remote's (the remote already ring-buffers it).
   * Trimmed defensively so the document can never grow unbounded.
   */
  setMetrics(
    id: string | Types.ObjectId,
    metrics: { step: number; loss: number; epoch?: number; lr?: number; at: string }[],
  ): Promise<FinetuneJobDoc | null> {
    const trimmed = metrics.length > METRICS_MAX ? metrics.slice(-METRICS_MAX) : metrics;
    return FinetuneJobModel.findByIdAndUpdate(id, { $set: { metrics: trimmed } }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<FinetuneJobDoc | null> {
    return FinetuneJobModel.findByIdAndDelete(id).exec();
  },
};
