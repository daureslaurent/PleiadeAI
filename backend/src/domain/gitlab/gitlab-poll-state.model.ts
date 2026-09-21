import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * How far the poller has read each source (`GITLAB_PLAN.md` §13.3).
 *
 * In Mongo rather than in memory, and that is the whole reason the collection exists: a cursor lost
 * on restart means the next tick re-reads a day of GitLab activity and starts a turn per row. The
 * same argument says a source with no document yet must record a **baseline and wake nobody** —
 * arming `mr_merged` on a year-old project must not replay its history.
 *
 * One document per source and project: `events:group/app`, `todos:<agentId>`, `todos:fleet`,
 * `pipelines:group/app`.
 */
const GitLabPollStateSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    /** Newest `created_at` consumed. Anything at or before it has been dealt with. */
    cursor: { type: Date, default: null },
    /**
     * Ids seen at exactly `cursor`. Two events created in the same millisecond would otherwise
     * either both replay forever or cost each other a wake, depending on which way the comparison
     * leans; keeping the tie-breakers is cheaper than either.
     */
    cursor_ids: { type: [String], default: [] },
    /** Todos only: ids are monotonic, so "everything up to here has been considered". */
    cursor_id: { type: Number, default: 0 },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: 'gitlab_poll_state', versionKey: false },
);

export type GitLabPollStateDoc = InferSchemaType<typeof GitLabPollStateSchema> & { _id: string };

export const GitLabPollStateModel = model('GitLabPollState', GitLabPollStateSchema);
