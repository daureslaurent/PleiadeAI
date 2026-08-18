import { AutoLoopModel, type AutoLoopDoc, type AutoLoopStatus } from './auto-loop.model';

/**
 * How many progress entries survive in the prompt block. Enough to see the shape of the last stretch
 * of work, few enough that a loop running overnight doesn't push its own history out of the context.
 */
export const MAX_PROGRESS = 8;

export interface StartLoopInput {
  sessionId: string;
  agentId: string;
  agentName: string;
  goal: string;
  seed: string;
  continueText: string;
  intervalSec: number;
}

export const autoLoopRepository = {
  findBySession(sessionId: string): Promise<AutoLoopDoc | null> {
    return AutoLoopModel.findOne({ session_id: sessionId }).exec();
  },

  /**
   * Create or re-arm the loop for a session. Upsert rather than insert: a session whose loop the
   * operator stopped (or whose agent declared done) is a perfectly ordinary conversation to start
   * looping again, and the unique index would reject a second document for it.
   *
   * Re-arming resets the counters — iteration, progress and the forum watermark — because the new
   * loop carries a new goal, and a recap of what the *previous* goal achieved would be read by the
   * agent as its own progress toward this one.
   */
  async start(input: StartLoopInput): Promise<AutoLoopDoc> {
    const now = new Date();
    const doc = await AutoLoopModel.findOneAndUpdate(
      { session_id: input.sessionId },
      {
        $set: {
          agent_id: input.agentId,
          agent_name: input.agentName,
          goal: input.goal,
          seed: input.seed,
          continue_text: input.continueText,
          interval_sec: input.intervalSec,
          status: 'waiting' as AutoLoopStatus,
          iteration: 0,
          progress: [],
          forum_seen_at: now,
          done_reason: '',
          last_error: '',
          consecutive_errors: 0,
          next_run_at: now,
          started_at: now,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).exec();
    return doc as AutoLoopDoc;
  },

  /** Every loop the scheduler must re-arm after a restart. */
  listActive(): Promise<AutoLoopDoc[]> {
    return AutoLoopModel.find({ status: { $in: ['running', 'waiting'] } }).exec();
  },

  setStatus(
    sessionId: string,
    status: AutoLoopStatus,
    extra: Record<string, unknown> = {},
  ): Promise<AutoLoopDoc | null> {
    return AutoLoopModel.findOneAndUpdate(
      { session_id: sessionId },
      { $set: { status, ...extra } },
      { new: true },
    ).exec();
  },

  /**
   * Record a completed iteration: bump the counter, append the recap entry (trimmed to the last
   * `MAX_PROGRESS` by `$slice`, so the cap is enforced in the write rather than by a read-modify-
   * write that two ticks could race on), clear the error streak and move the forum watermark up.
   */
  recordTurn(
    sessionId: string,
    entry: { n: number; summary: string },
    forumSeenAt: Date,
  ): Promise<AutoLoopDoc | null> {
    return AutoLoopModel.findOneAndUpdate(
      { session_id: sessionId },
      {
        $set: { iteration: entry.n, last_error: '', consecutive_errors: 0, forum_seen_at: forumSeenAt },
        $push: { progress: { $each: [{ ...entry, at: new Date() }], $slice: -MAX_PROGRESS } },
      },
      { new: true },
    ).exec();
  },

  /** Record a failed iteration and return the doc, so the caller can read the new streak length. */
  recordError(sessionId: string, n: number, message: string): Promise<AutoLoopDoc | null> {
    return AutoLoopModel.findOneAndUpdate(
      { session_id: sessionId },
      { $set: { iteration: n, last_error: message }, $inc: { consecutive_errors: 1 } },
      { new: true },
    ).exec();
  },

  /** Arm the countdown to the next tick (what the panel renders). */
  arm(sessionId: string, nextRunAt: Date): Promise<AutoLoopDoc | null> {
    return AutoLoopModel.findOneAndUpdate(
      { session_id: sessionId },
      { $set: { status: 'waiting' as AutoLoopStatus, next_run_at: nextRunAt } },
      { new: true },
    ).exec();
  },

  /** Drop a session's loop entirely (called when the session itself is deleted). */
  async removeBySession(sessionId: string): Promise<void> {
    await AutoLoopModel.deleteOne({ session_id: sessionId }).exec();
  },
};
