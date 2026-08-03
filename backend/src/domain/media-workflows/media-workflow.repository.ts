import { Types } from 'mongoose';
import {
  MediaWorkflowModel,
  type MediaWorkflowDoc,
  type WorkflowBindings,
  type WorkflowKind,
} from './media-workflow.model';
import type { ComfyGraph } from '../../media/comfy/types';

export interface CreateWorkflowInput {
  name: string;
  kind: WorkflowKind;
  graph: ComfyGraph;
  bindings: WorkflowBindings;
  output_node_id: string;
  output_kind: 'image' | 'video' | 'audio';
  description?: string;
  source?: 'discovered' | 'manual';
  source_prompt_id?: string;
  source_workflow_uuid?: string;
  graph_hash?: string;
  avg_duration_ms?: number;
}

/** Data-access for operator-curated ComfyUI workflows. Thin; the logic lives in the media services. */
export const mediaWorkflowRepository = {
  list(kind?: WorkflowKind): Promise<MediaWorkflowDoc[]> {
    return MediaWorkflowModel.find(kind ? { kind } : {})
      .sort({ name: 1 })
      .exec();
  },

  /** Selectable workflows for a tool: the right kind, not disabled. */
  listEnabled(kind: WorkflowKind): Promise<MediaWorkflowDoc[]> {
    return MediaWorkflowModel.find({ kind, enabled: true }).sort({ name: 1 }).exec();
  },

  findById(id: string): Promise<MediaWorkflowDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return MediaWorkflowModel.findById(id).exec();
  },

  findByHash(graphHash: string): Promise<MediaWorkflowDoc | null> {
    return MediaWorkflowModel.findOne({ graph_hash: graphHash }).exec();
  },

  /** Hashes already imported — lets the discovery list mark candidates as known. */
  async importedHashes(): Promise<Set<string>> {
    const docs = await MediaWorkflowModel.find({}, { graph_hash: 1 }).lean().exec();
    return new Set(docs.map((d) => d.graph_hash).filter((h): h is string => Boolean(h)));
  },

  create(input: CreateWorkflowInput): Promise<MediaWorkflowDoc> {
    return MediaWorkflowModel.create({ ...input });
  },

  update(id: string, patch: Record<string, unknown>): Promise<MediaWorkflowDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return MediaWorkflowModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await MediaWorkflowModel.findByIdAndDelete(id).exec();
    return Boolean(res);
  },

  /**
   * Fold an observed runtime into the workflow's rolling average, so the UI can tell the operator
   * (and the tool's timeout hint) roughly what a run costs. Exponential moving average, weighted so a
   * single outlier — a cold model load, a queue wait — doesn't dominate.
   */
  async recordDuration(id: string, durationMs: number): Promise<void> {
    const doc = await this.findById(id);
    if (!doc) return;
    const prior = doc.avg_duration_ms || 0;
    const next = prior > 0 ? Math.round(prior * 0.7 + durationMs * 0.3) : durationMs;
    await MediaWorkflowModel.updateOne({ _id: doc._id }, { $set: { avg_duration_ms: next } }).exec();
  },
};
