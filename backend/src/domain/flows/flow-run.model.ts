import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import type { FlowValue } from './flow.model';

export const FLOW_RUN_STATUSES = ['running', 'awaiting_input', 'success', 'error', 'aborted'] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const FLOW_NODE_STATUSES = ['pending', 'running', 'success', 'error', 'skipped'] as const;
export type FlowNodeStatus = (typeof FLOW_NODE_STATUSES)[number];

export const FLOW_TRIGGERS = ['manual', 'agent', 'cron', 'api'] as const;
export type FlowTrigger = (typeof FLOW_TRIGGERS)[number];

/** Per-node trace for one run: what it did, how long it took, and what came out. */
export interface FlowNodeState {
  node_id: string;
  status: FlowNodeStatus;
  started_at?: Date | null;
  ended_at?: Date | null;
  /** Truncated output (spec §6) — the run doc is a trace, the artifacts live in `resources`. */
  output?: Record<string, FlowValue> | null;
  error?: string;
  /** Set on nodes inside a `for_each` body, so repeated executions stay distinguishable. */
  iteration?: number | null;
}

/** Where a log line came from — the Debug view colours and filters by this. */
export const FLOW_LOG_SOURCES = ['node', 'agent', 'tool', 'media', 'system'] as const;
export type FlowLogSource = (typeof FLOW_LOG_SOURCES)[number];

/**
 * One line of the run's debug trace (flows spec §6.2).
 *
 * Flat and chronological rather than nested per node, because the question this answers is usually
 * "what happened, in what order" — a node's own output is reachable by filtering on `node_id`, but
 * the interleaving between two nodes cannot be reconstructed from per-node buckets.
 */
export interface FlowLogEntry {
  at: Date;
  node_id: string;
  source: FlowLogSource;
  text: string;
  /** Set inside a `for_each` body, so one iteration's lines are tellable from another's. */
  iteration?: number | null;
}

const LogEntrySchema = new Schema<FlowLogEntry>(
  {
    at: { type: Date, default: () => new Date() },
    node_id: { type: String, required: true },
    source: { type: String, enum: FLOW_LOG_SOURCES, default: 'node' },
    text: { type: String, default: '' },
    iteration: { type: Number, default: null },
  },
  { _id: false },
);

/** A question the run is blocked on (currently only the human approval gate). */
export interface FlowPending {
  node_id: string;
  kind: 'approval';
  question: string;
  /** Resource handles the operator should look at before answering. */
  artifacts: string[];
  asked_at: Date;
}

const NodeStateSchema = new Schema<FlowNodeState>(
  {
    node_id: { type: String, required: true },
    status: { type: String, enum: FLOW_NODE_STATUSES, default: 'pending' },
    started_at: { type: Date, default: null },
    ended_at: { type: Date, default: null },
    output: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: '' },
    iteration: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * `flow_runs` — one execution of a flow (spec §6).
 *
 * `session_id` is this document's own id: every artifact a node produces is stored as a session
 * resource under it, which is what makes handles, the `/api/resources/:sessionId/:handle/content`
 * preview route and the socket room all work without a line of flow-specific plumbing (spec §1.1).
 */
const FlowRunSchema = new Schema(
  {
    flow_id: { type: String, required: true, index: true },
    /** Denormalised so a run stays readable after its flow is renamed or deleted. */
    flow_name: { type: String, default: '' },
    status: { type: String, enum: FLOW_RUN_STATUSES, default: 'running', index: true },
    trigger: { type: String, enum: FLOW_TRIGGERS, default: 'manual' },
    /** Resource/socket session for this run — equals `String(_id)`. */
    session_id: { type: String, default: '', index: true },
    /** Values the operator (or caller) supplied for the flow's `input` nodes. */
    inputs: { type: Schema.Types.Mixed, default: {} },
    nodes: { type: [NodeStateSchema], default: [] },
    /**
     * The debug trace. Written in batches by the runner (an agent streaming tokens would otherwise be
     * thousands of writes) and capped per node, so a chatty tool inside a 20-item loop can't grow the
     * document without bound — the run doc is a trace, not a log store.
     */
    logs: { type: [LogEntrySchema], default: [] },
    pending: { type: Schema.Types.Mixed, default: null },
    output: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: '' },
    started_at: { type: Date, default: () => new Date() },
    ended_at: { type: Date, default: null },
  },
  { collection: 'flow_runs' },
);

FlowRunSchema.index({ flow_id: 1, started_at: -1 });

export type FlowRun = InferSchemaType<typeof FlowRunSchema>;
export type FlowRunDoc = HydratedDocument<FlowRun>;

export const FlowRunModel = model('FlowRun', FlowRunSchema);
