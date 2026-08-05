import { Types } from 'mongoose';
import {
  FlowRunModel,
  type FlowLogEntry,
  type FlowNodeState,
  type FlowPending,
  type FlowRunDoc,
  type FlowRunStatus,
  type FlowTrigger,
} from './flow-run.model';
import type { FlowValue } from './flow.model';

export interface CreateRunInput {
  flow_id: string;
  flow_name: string;
  trigger: FlowTrigger;
  inputs: Record<string, unknown>;
  nodes: FlowNodeState[];
}

/**
 * Data-access for flow runs. Node-state writes are targeted `$set`s on the array element rather than
 * whole-document saves: a run is written to dozens of times while a ten-minute video renders, and two
 * branches executing concurrently must not clobber each other's node states.
 */
export const flowRunRepository = {
  async create(input: CreateRunInput): Promise<FlowRunDoc> {
    const doc = await FlowRunModel.create({ ...input, status: 'running' });
    // The run *is* its own session (spec §1.1) — resources and the socket room key off this.
    doc.session_id = String(doc._id);
    await doc.save();
    return doc;
  },

  findById(id: string): Promise<FlowRunDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return FlowRunModel.findById(id).exec();
  },

  /** Run history, newest first. Scoped to one flow when `flowId` is given. */
  list(flowId: string | undefined, limit = 50): Promise<FlowRunDoc[]> {
    return FlowRunModel.find(flowId ? { flow_id: flowId } : {})
      .sort({ started_at: -1 })
      .limit(Math.max(1, Math.min(200, limit)))
      .exec();
  },

  /**
   * Patch one node's state in place, leaving sibling branches untouched.
   *
   * `iteration` is part of the *filter*, not the patch: a node inside a `for_each` body has one row
   * per pass, and matching on the id alone would rewrite all of them with the latest pass's result —
   * turning a three-iteration trace into three copies of iteration three.
   */
  async patchNode(
    runId: string,
    nodeId: string,
    patch: Partial<FlowNodeState>,
    iteration?: number,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(runId)) return;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) set[`nodes.$[n].${key}`] = value;
    await FlowRunModel.updateOne(
      { _id: runId },
      { $set: set },
      { arrayFilters: [{ 'n.node_id': nodeId, 'n.iteration': iteration ?? null }] },
    ).exec();
  },

  /** Append a node state (a `for_each` body re-runs its nodes, one state row per iteration). */
  async addNode(runId: string, state: FlowNodeState): Promise<void> {
    if (!Types.ObjectId.isValid(runId)) return;
    await FlowRunModel.updateOne({ _id: runId }, { $push: { nodes: state } }).exec();
  },

  /**
   * Replace the run's debug trace. A whole-array `$set` rather than `$push`, because the runner holds
   * the authoritative capped buffer in memory — pushing would need the per-node cap enforced in the
   * database, and a `$slice` can only bound the array globally, which would let one noisy node evict
   * every other node's lines.
   */
  async setLogs(runId: string, logs: FlowLogEntry[]): Promise<void> {
    if (!Types.ObjectId.isValid(runId)) return;
    await FlowRunModel.updateOne({ _id: runId }, { $set: { logs } }).exec();
  },

  async setPending(runId: string, pending: FlowPending | null): Promise<void> {
    if (!Types.ObjectId.isValid(runId)) return;
    await FlowRunModel.updateOne(
      { _id: runId },
      { $set: { pending, status: pending ? 'awaiting_input' : 'running' } },
    ).exec();
  },

  async finish(
    runId: string,
    status: FlowRunStatus,
    result: { output?: Record<string, FlowValue> | null; error?: string },
  ): Promise<void> {
    if (!Types.ObjectId.isValid(runId)) return;
    await FlowRunModel.updateOne(
      { _id: runId },
      {
        $set: {
          status,
          output: result.output ?? null,
          error: result.error ?? '',
          pending: null,
          ended_at: new Date(),
        },
      },
    ).exec();
  },

  /**
   * Fail every run left mid-flight by a restart (spec §4, boot sweep). A half-executed flow whose
   * in-memory executor died must never keep reading as live in the UI.
   */
  async failInterrupted(): Promise<number> {
    const res = await FlowRunModel.updateMany(
      { status: { $in: ['running', 'awaiting_input'] } },
      {
        $set: {
          status: 'error',
          error: 'the backend restarted while this run was in flight',
          pending: null,
          ended_at: new Date(),
        },
      },
    ).exec();
    return res.modifiedCount ?? 0;
  },

  /** Drop a flow's run history when the flow itself is deleted. */
  async removeByFlow(flowId: string): Promise<void> {
    await FlowRunModel.deleteMany({ flow_id: flowId }).exec();
  },
};
