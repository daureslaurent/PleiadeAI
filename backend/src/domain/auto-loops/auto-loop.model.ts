import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `auto_loops` collection (spec `AUTO_AGENT_PLAN.md` §3). One document per self-driving
 * conversation: an agent flagged `auto_mode` that the operator has pointed at a standing goal and
 * left to run.
 *
 * A loop *is* a session — `session_id` is unique — which is the same choice Flows made with run ids:
 * every turn the loop produces is an ordinary session message, the Workspace's existing
 * `session:subscribe` streams it live, and nothing about persistence, resources or scoring needs a
 * second code path. Two loops on one conversation would be two schedulers writing into one history.
 *
 * Distinct from an autonomy cron job, which starts a *fresh* stateless session on every fire. A loop
 * keeps its history, todo list and session resources across iterations: it is one long conversation
 * the agent holds with itself.
 */
const AutoLoopSchema = new Schema(
  {
    session_id: { type: String, required: true, unique: true, index: true },
    agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', required: true, index: true },
    /** Denormalised so the scheduler and the UI never need a populate to name the agent. */
    agent_name: { type: String, required: true },
    /**
     * `running` — a turn is executing right now; `waiting` — armed, counting down to the next tick.
     * The two are split (rather than one `active`) because they mean different things to the
     * operator: one is "the agent is working", the other is "the agent is idle until `next_run_at`",
     * and the panel renders a spinner for one and a countdown for the other.
     *
     * `done` is the agent's own verdict (`loop_done`), `stopped` is the operator's, and `error` is
     * the circuit breaker. All three are terminal — restarting means starting a new loop.
     */
    status: {
      type: String,
      enum: ['idle', 'running', 'waiting', 'done', 'stopped', 'error'],
      default: 'idle',
      index: true,
    },
    /**
     * The standing objective, injected into *every* iteration's prompt rather than only the first.
     * That repetition is the point: history gets truncated as a loop runs for hours, and a goal that
     * lives only in turn 1 is a goal the agent silently drifts away from by turn 40.
     */
    goal: { type: String, default: '' },
    /** Kickoff message — sent as the user turn of iteration 1 only. */
    seed: { type: String, default: '' },
    /** The user turn of every iteration after the first. */
    continue_text: { type: String, default: '' },
    /**
     * Delay between the *end* of one turn and the start of the next. Measured from completion rather
     * than on a wall clock so a turn that outruns its own interval can never overlap itself.
     */
    interval_sec: { type: Number, default: 60 },
    /** Turns completed so far (successful or failed). */
    iteration: { type: Number, default: 0 },
    /**
     * Rolling recap fed back into the prompt each tick — what the agent said it did, iteration by
     * iteration. Trimmed to the last `MAX_PROGRESS` entries by the repository: the block exists to
     * stop drift, and a hundred stale summaries would cause the context flooding it's meant to avoid.
     */
    progress: {
      type: [
        {
          _id: false,
          n: { type: Number, required: true },
          at: { type: Date, default: Date.now },
          summary: { type: String, default: '' },
        },
      ],
      default: [],
    },
    /** Watermark for the "new on the forum since your last turn" digest. */
    forum_seen_at: { type: Date, default: Date.now },
    /** The agent's own closing summary, from its `loop_done` call. */
    done_reason: { type: String, default: '' },
    last_error: { type: String, default: '' },
    /** Consecutive failed turns; the breaker parks the loop when this hits its ceiling. */
    consecutive_errors: { type: Number, default: 0 },
    /** When the next tick fires — drives the panel's countdown. Null while a turn is running. */
    next_run_at: { type: Date, default: null },
    started_at: { type: Date, default: Date.now },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'auto_loops',
  },
);

export type AutoLoop = InferSchemaType<typeof AutoLoopSchema>;
export type AutoLoopDoc = HydratedDocument<AutoLoop>;
export type AutoLoopStatus = AutoLoop['status'];

export const AutoLoopModel = model('AutoLoop', AutoLoopSchema);
