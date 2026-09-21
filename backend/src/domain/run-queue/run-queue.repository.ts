import { Types } from 'mongoose';
import { createLogger } from '../../config/logger';
import { RunQueueModel, type RunQueueDoc } from './run-queue.model';

const log = createLogger('run-queue');

export interface RunQueueInput {
  source: string;
  kind?: string;
  origin?: string;
  agentId: string;
  agentName: string;
  title?: string;
  project?: string;
  url?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  dedupeKey?: string;
  /** Set when the conversation exists before the run does — an auto loop runs in its own session. */
  sessionId?: string;
}

/** Rows that have not finished — the queue proper, as opposed to its history. */
const LIVE = ['queued', 'running'];

export const runQueueRepository = {
  async insert(input: RunQueueInput): Promise<RunQueueDoc> {
    const doc = await RunQueueModel.create({
      source: input.source,
      kind: input.kind ?? '',
      origin: input.origin ?? '',
      agent_id: input.agentId,
      agent_name: input.agentName,
      title: (input.title ?? '').slice(0, 300),
      project: input.project ?? '',
      url: input.url ?? '',
      payload: input.payload ?? {},
      priority: input.priority ?? 0,
      dedupe_key: input.dedupeKey ?? '',
      session_id: input.sessionId ?? '',
      status: 'queued',
      queued_at: new Date(),
    });
    return doc.toObject() as unknown as RunQueueDoc;
  },

  /**
   * Take the next row and mark it running, atomically.
   *
   * The atomicity is not defensive tidiness: `drain()` is kicked by every enqueue, and a second
   * process (a container restarted while the old one was still finishing) would otherwise run the
   * same row twice. One `findOneAndUpdate` filtered on `status: 'queued'` makes a lost race a
   * no-op rather than a duplicate inference call.
   */
  async claim(): Promise<RunQueueDoc | null> {
    return RunQueueModel.findOneAndUpdate(
      { status: 'queued' },
      { $set: { status: 'running', started_at: new Date() } },
      { sort: { priority: -1, queued_at: 1 }, new: true },
    ).lean<RunQueueDoc>();
  },

  /** The turn exists now — link it before the run finishes, so the row is clickable while it streams. */
  async attachSession(id: string, sessionId: string): Promise<void> {
    await RunQueueModel.updateOne({ _id: id }, { $set: { session_id: sessionId } }).catch((err) =>
      log.warn({ err: String(err), id }, 'could not attach session to a run-queue row'),
    );
  },

  async finish(id: string, status: 'done' | 'failed' | 'interrupted', error?: string): Promise<void> {
    await RunQueueModel.updateOne(
      { _id: id },
      { $set: { status, ended_at: new Date(), error: (error ?? '').slice(0, 1000) } },
    );
  },

  /** Cancel a row that has not started. A running turn is stopped from the Workspace, not here. */
  async cancel(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await RunQueueModel.updateOne(
      { _id: id, status: 'queued' },
      { $set: { status: 'cancelled', ended_at: new Date() } },
    );
    return res.modifiedCount > 0;
  },

  /**
   * Put a row in front of everything else waiting.
   *
   * One above the highest queued priority rather than a fixed number: two rows promoted in turn
   * then keep the order they were promoted in, which is what the operator meant both times.
   */
  async promote(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const top = await RunQueueModel.findOne({ status: 'queued' }).sort({ priority: -1 }).lean<RunQueueDoc>();
    const priority = (top?.priority ?? 0) + 1;
    const res = await RunQueueModel.updateOne({ _id: id, status: 'queued' }, { $set: { priority } });
    return res.modifiedCount > 0;
  },

  async findById(id: string): Promise<RunQueueDoc | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return RunQueueModel.findById(id).lean<RunQueueDoc>();
  },

  /** Is this delivery already waiting, or already being run? */
  async isPending(dedupeKey: string): Promise<boolean> {
    if (!dedupeKey) return false;
    return (await RunQueueModel.countDocuments({ dedupe_key: dedupeKey, status: { $in: LIVE } })) > 0;
  },

  /**
   * Everything queued or running, in the order it will run — every source, so the lane is honest
   * even on a page that lists only one of them. `status: -1` puts `running` first (it sorts after
   * `queued`), which is the order the list is read in.
   */
  async live(): Promise<RunQueueDoc[]> {
    return RunQueueModel.find({ status: { $in: LIVE } })
      .sort({ status: -1, priority: -1, queued_at: 1 })
      .lean<RunQueueDoc[]>();
  },

  /** Finished rows, newest first — optionally for one source. */
  async history(opts: { source?: string; limit?: number } = {}): Promise<RunQueueDoc[]> {
    const filter: Record<string, unknown> = { status: { $nin: LIVE } };
    if (opts.source) filter.source = opts.source;
    return RunQueueModel.find(filter)
      .sort({ ended_at: -1, queued_at: -1 })
      .limit(Math.min(200, opts.limit ?? 25))
      .lean<RunQueueDoc[]>();
  },

  async countQueued(): Promise<number> {
    return RunQueueModel.countDocuments({ status: 'queued' });
  },

  /**
   * At boot: a row left `running` belongs to a process that is gone.
   *
   * It is marked `interrupted` rather than re-queued, because the turn may have streamed half an
   * answer and posted a GitLab comment before the container died — re-running it would post the
   * comment twice. The honest record is "this one did not finish"; the operator re-triggers it if
   * it mattered.
   */
  async recover(): Promise<number> {
    const res = await RunQueueModel.updateMany(
      { status: 'running' },
      { $set: { status: 'interrupted', ended_at: new Date(), error: 'the backend restarted mid-run' } },
    );
    if (res.modifiedCount) log.warn({ count: res.modifiedCount }, 'runs interrupted by a restart');
    return res.modifiedCount;
  },
};
