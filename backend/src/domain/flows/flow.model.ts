import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * The value types that travel along a flow edge (flows spec §2).
 *
 * Binary payloads (`image`/`video`/`audio`/`file`) move as **resource handles**, never as bytes: the
 * bytes already live in GridFS under the run's session, so an edge carries `img_2` rather than 200 MB
 * of mp4. `signal` is the control-flow ("action") edge — it carries nothing but "I finished, now run".
 */
export const PORT_TYPES = ['text', 'image', 'video', 'audio', 'file', 'json', 'signal'] as const;
export type PortType = (typeof PORT_TYPES)[number];

/** A value produced by a node and carried on its outgoing edges. */
export interface FlowValue {
  type: PortType;
  /** Text rendering (also how `json` is shown, and how any value stringifies into a text port). */
  text?: string;
  /** Resource handles for binary kinds — `img_N` / `blob_N`, resolvable in the run's session. */
  handles?: string[];
  /** Structured payload (tool results, lists a `for_each` iterates). */
  json?: unknown;
}

/**
 * One node on the canvas. `type` names a handler in `flows/nodes/`; `config` is that handler's own
 * `ToolConfigField[]` filled in by the operator. Everything else is graph bookkeeping.
 */
export interface FlowNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
  /**
   * Identity a tool/media node executes under (flows spec §3.1). Names an agent, whose isolation
   * container (or SSH jump box) the node's `bash`/file work runs inside — so one node can execute on
   * a remote host while its neighbour runs in the backend. Unset = plain backend execution.
   */
  run_as_agent?: string;
}

/** A typed connection between two node ports. */
export interface FlowEdge {
  id: string;
  source: string;
  source_port: string;
  target: string;
  target_port: string;
}

const NodeSchema = new Schema<FlowNode>(
  {
    id: { type: String, required: true },
    type: { type: String, required: true },
    label: { type: String, default: '' },
    position: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    config: { type: Schema.Types.Mixed, default: {} },
    run_as_agent: { type: String, default: '' },
  },
  { _id: false },
);

const EdgeSchema = new Schema<FlowEdge>(
  {
    id: { type: String, required: true },
    source: { type: String, required: true },
    source_port: { type: String, required: true },
    target: { type: String, required: true },
    target_port: { type: String, required: true },
  },
  { _id: false },
);

/**
 * `flows` — an operator-authored node graph the backend executes in a fixed order (spec `FLOWS_PLAN.md`).
 *
 * The deterministic counterpart to an agent choosing its own tool order: the same primitives
 * (`agentRunner.run`, `generateMedia`, any registered tool) wired by hand, so a pipeline repeats
 * identically instead of depending on what the model felt like doing this time.
 */
const FlowSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    /** Off means the flow can't be run by an agent or a schedule (manual runs still work, for testing). */
    enabled: { type: Boolean, default: true },
    /**
     * Whether this flow's `timer` node is armed (STREAMING_PLAN.md §4). Persisted rather than kept
     * in `FlowTimerScheduler`'s memory alone so a backend restart puts the streams back on air.
     */
    timer_armed: { type: Boolean, default: false },
    nodes: { type: [NodeSchema], default: [] },
    edges: { type: [EdgeSchema], default: [] },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'flows' },
);

export type Flow = InferSchemaType<typeof FlowSchema>;
export type FlowDoc = HydratedDocument<Flow>;

export const FlowModel = model('Flow', FlowSchema);
