import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import type { ComfyGraph, ComfyInputSpec } from '../../media/comfy/types';

/** The content a workflow produces. Drives which tool can select it. */
export const WORKFLOW_KINDS = ['image', 'video', 'audio', 'edit'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

/**
 * The logical parameters a tool can drive on a workflow. Every one is optional: a graph feeds many of
 * these from upstream nodes (the MiniMax video workflow computes its frame count with a math node),
 * and an unbound parameter simply means the tool's config for it is ignored.
 */
export const BINDING_KEYS = [
  'prompt',
  'negative_prompt',
  'seed',
  'width',
  'height',
  'length',
  'seconds',
  'fps',
  'batch',
  'image1',
  'image2',
  'image3',
  // A generative video model can be driven by a reference *sound* as well as a reference image —
  // LTX 2.3 lip-syncs and paces its motion to one. Bound from `LoadAudio`, uploaded the same way an
  // input image is.
  'audio1',
  'audio2',
  'filename_prefix',
] as const;
export type BindingKey = (typeof BINDING_KEYS)[number];

/** One logical parameter pinned to a concrete `graph[node_id].inputs[input]`. */
export interface WorkflowBinding {
  node_id: string;
  input: string;
  /**
   * Snapshot of the node schema's constraints for this input, refreshed on validate. Used to clamp
   * values before submitting — MiniMax H3's `length` declares `step: 17`, the frame grid the model
   * requires, and sending an off-grid value wastes a ten-minute run.
   */
  spec?: ComfyInputSpec;
  /**
   * True when the input was fed by another node at import time. Binding it is still legal — writing a
   * literal orphans the upstream chain — but it *overrides* whatever that chain computed, so the UI
   * warns and the operator gets to decide.
   */
  overrides_link?: boolean;
}

export type WorkflowBindings = Partial<Record<BindingKey, WorkflowBinding>>;

/**
 * `media_workflows` — an operator-curated ComfyUI workflow the media tools can run.
 *
 * `graph` is a **snapshot**, deliberately. ComfyUI keeps its run history in memory and loses it on
 * restart, and the workflows the editor saves are in the UI's own subgraph-bearing format rather than
 * the flat API format that `POST /prompt` accepts. Copying the graph in at import time is what makes a
 * workflow survive a ComfyUI restart, and what stops an edit in the ComfyUI editor from silently
 * changing what an agent runs.
 */
const MediaWorkflowSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    kind: { type: String, enum: WORKFLOW_KINDS, required: true },
    description: { type: String, default: '' },
    /** API-format graph: `{ [nodeId]: { class_type, inputs, _meta } }`. */
    graph: { type: Schema.Types.Mixed, required: true },
    /** Logical parameter → `{node_id, input}`. See {@link WorkflowBindings}. */
    bindings: { type: Schema.Types.Mixed, default: {} },
    /** Node whose saved files are the result. Its artifacts sort first when collecting outputs. */
    output_node_id: { type: String, default: '' },
    /** Expected media type of the result, used to pick the right artifact and mime. */
    output_kind: { type: String, enum: ['image', 'video', 'audio'], default: 'image' },
    source: { type: String, enum: ['discovered', 'manual'], default: 'discovered' },
    /** Provenance only — never dereferenced, since ComfyUI's history doesn't outlive a restart. */
    source_prompt_id: { type: String, default: '' },
    /** `extra_data.workflow.id` from the run, so a newer run of the same workflow can be matched. */
    source_workflow_uuid: { type: String, default: '' },
    /** sha1 of the graph with bound literals blanked — dedups repeat runs of one workflow. */
    graph_hash: { type: String, default: '', index: true },
    enabled: { type: Boolean, default: true },
    /** Rolling average runtime, seeded from the discovered run's own timings. 0 → unknown. */
    avg_duration_ms: { type: Number, default: 0 },
    last_validated_at: { type: Date, default: null },
    last_validation_error: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { collection: 'media_workflows', timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

export type MediaWorkflow = InferSchemaType<typeof MediaWorkflowSchema>;
export type MediaWorkflowDoc = HydratedDocument<MediaWorkflow>;

export const MediaWorkflowModel = model('MediaWorkflow', MediaWorkflowSchema);

/** Typed view of the `Mixed` fields, which Mongoose can't narrow for us. */
export function graphOf(doc: MediaWorkflowDoc): ComfyGraph {
  return doc.graph as ComfyGraph;
}

export function bindingsOf(doc: MediaWorkflowDoc): WorkflowBindings {
  return (doc.bindings ?? {}) as WorkflowBindings;
}
