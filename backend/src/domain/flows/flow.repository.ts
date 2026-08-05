import { Types } from 'mongoose';
import { FlowModel, type FlowDoc, type FlowEdge, type FlowNode } from './flow.model';

export interface CreateFlowInput {
  name: string;
  description?: string;
  enabled?: boolean;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
}

/** Data-access for saved flows. Thin — validation and execution live in `flows/`. */
export const flowRepository = {
  list(): Promise<FlowDoc[]> {
    return FlowModel.find({}).sort({ name: 1 }).exec();
  },

  /** Flows an agent or a schedule may run. */
  listEnabled(): Promise<FlowDoc[]> {
    return FlowModel.find({ enabled: true }).sort({ name: 1 }).exec();
  },

  findById(id: string): Promise<FlowDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return FlowModel.findById(id).exec();
  },

  findByName(name: string): Promise<FlowDoc | null> {
    return FlowModel.findOne({ name }).exec();
  },

  /** Resolve by id *or* name — the `run_flow` tool addresses flows by name, the UI by id. */
  async findByIdOrName(idOrName: string): Promise<FlowDoc | null> {
    return (await this.findById(idOrName)) ?? (await this.findByName(idOrName));
  },

  create(input: CreateFlowInput): Promise<FlowDoc> {
    return FlowModel.create({ ...input });
  },

  update(id: string, patch: Record<string, unknown>): Promise<FlowDoc | null> {
    if (!Types.ObjectId.isValid(id)) return Promise.resolve(null);
    return FlowModel.findByIdAndUpdate(id, { $set: { ...patch, updated_at: new Date() } }, { new: true }).exec();
  },

  async remove(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await FlowModel.findByIdAndDelete(id).exec();
    return Boolean(res);
  },
};
