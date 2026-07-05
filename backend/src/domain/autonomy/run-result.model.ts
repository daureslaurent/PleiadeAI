import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `autonomy_run_results` collection — the durable history of every autonomous task execution,
 * keyed by the owning Agenda job so the UI can list "all previous results" for one schedule.
 *
 * `schedule_id` is the stable Agenda job `_id` (string). Run-now executions reuse it via the
 * `scheduleId` carried in the job payload, so ad-hoc runs land in the same history as scheduled ones.
 */
const RunResultSchema = new Schema(
  {
    schedule_id: { type: String, required: true, index: true },
    agent_name: { type: String, required: true },
    prompt: { type: String, required: true },
    status: { type: String, enum: ['success', 'error'], required: true },
    /** Full markdown output of the run (or the error message when `status === 'error'`). */
    output: { type: String, default: '' },
    started_at: { type: Date, required: true },
    finished_at: { type: Date, default: () => new Date() },
  },
  { collection: 'autonomy_run_results' },
);

export type RunResult = InferSchemaType<typeof RunResultSchema>;
export type RunResultDoc = HydratedDocument<RunResult>;

export const RunResultModel = model('AutonomyRunResult', RunResultSchema);
