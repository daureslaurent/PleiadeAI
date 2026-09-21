import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * One autonomous agent turn, waiting for the inference server (`RUN_QUEUE_PLAN.md` §3).
 *
 * The collection *is* the queue, not a log of it. That is the difference from the two in-memory
 * queues it replaces (`gitlab-wake-runner.ts`, `forum-wake-queue.ts`), and it buys three things
 * those could not have: the order survives a restart, the operator can act on a row before it costs
 * an inference call, and "why did nothing run last night" is answerable afterwards instead of
 * having existed only in a container's stdout.
 *
 * A row carries everything its handler needs in `payload`, so nothing has to be reconstructed from
 * memory to run it — which is what makes a restart mid-queue resumable rather than lost.
 */
const RunQueueSchema = new Schema(
  {
    /** Which subsystem wants the turn, and therefore which registered handler runs it. */
    source: { type: String, required: true, index: true },
    /** What happened, inside that source: `issue`, `mr_merged`, `check`, `mention`, `cron`. */
    kind: { type: String, default: '' },
    /** One line naming how it arrived — `webhook`, `poll · todo`, `Check now`. */
    origin: { type: String, default: '' },
    agent_id: { type: String, required: true },
    agent_name: { type: String, required: true, index: true },
    /** What the operator reads in the list: the issue title, the project being checked. */
    title: { type: String, default: '' },
    /** Where it is, if it is anywhere — shown as a link on the row. */
    project: { type: String, default: '' },
    url: { type: String, default: '' },
    /** Everything the handler needs. Opaque here on purpose: the lane knows no source's shape. */
    payload: { type: Schema.Types.Mixed, default: {} },
    /** Higher runs first. Operator-initiated work (Check now, a promoted row) sits above wakes. */
    priority: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['queued', 'running', 'done', 'failed', 'cancelled', 'interrupted'],
      default: 'queued',
      index: true,
    },
    /** The conversation the turn was recorded into — set once it starts. */
    session_id: { type: String, default: '' },
    error: { type: String, default: '' },
    /**
     * What this row is a duplicate *of*, if the source can say: GitLab retries a delivery it thinks
     * failed, and a poll tick re-reads a to-do it has not yet marked done.
     */
    dedupe_key: { type: String, default: '' },
    queued_at: { type: Date, default: Date.now, index: true },
    started_at: { type: Date, default: null },
    ended_at: { type: Date, default: null },
  },
  { collection: 'run_queue', versionKey: false },
);

// The claim: the next thing to run, highest priority first and oldest first within a priority.
RunQueueSchema.index({ status: 1, priority: -1, queued_at: 1 });
// The tab: one source's history, newest first.
RunQueueSchema.index({ source: 1, queued_at: -1 });
// Deduplication is a lookup among rows that have not finished — a delivery seen again a week later
// after its row completed is a genuinely new event as far as anybody can tell.
RunQueueSchema.index({ dedupe_key: 1, status: 1 });

export type RunQueueDoc = InferSchemaType<typeof RunQueueSchema> & { _id: string };

export const RunQueueModel = model('RunQueue', RunQueueSchema);
