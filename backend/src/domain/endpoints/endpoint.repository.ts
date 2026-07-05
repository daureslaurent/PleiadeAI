import { Types } from 'mongoose';
import { EndpointModel, type EndpointDoc } from './endpoint.model';

/** Data-access for inference endpoints. Kept thin; the resolver/service layer holds the logic. */
export const endpointRepository = {
  list(): Promise<EndpointDoc[]> {
    return EndpointModel.find().sort({ name: 1 }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<EndpointDoc | null> {
    return EndpointModel.findById(id).exec();
  },

  findByName(name: string): Promise<EndpointDoc | null> {
    return EndpointModel.findOne({ name }).exec();
  },

  /** The single system-managed endpoint (built-in local docker fallback), if it exists. */
  findManaged(): Promise<EndpointDoc | null> {
    return EndpointModel.findOne({ managed: true }).exec();
  },

  findDefault(): Promise<EndpointDoc | null> {
    return EndpointModel.findOne({ is_default: true }).exec();
  },

  /** The failover chain: endpoints opted into fallback (`fallback_order > 0`), lowest order first. */
  listFallbacks(): Promise<EndpointDoc[]> {
    return EndpointModel.find({ fallback_order: { $gt: 0 } }).sort({ fallback_order: 1 }).exec();
  },

  count(): Promise<number> {
    return EndpointModel.countDocuments().exec();
  },

  async create(input: {
    name: string;
    base_url: string;
    api_key?: string;
    context_window?: number;
    is_default?: boolean;
    fallback_order?: number;
    default_model?: string;
    models?: string[];
    managed?: boolean;
  }): Promise<EndpointDoc> {
    // First endpoint ever created is implicitly the default so agents always have a target.
    const makeDefault = input.is_default || (await this.count()) === 0;
    if (makeDefault) await EndpointModel.updateMany({}, { $set: { is_default: false } }).exec();
    return EndpointModel.create({ ...input, is_default: makeDefault });
  },

  update(
    id: string | Types.ObjectId,
    patch: Partial<
      Pick<EndpointDoc, 'name' | 'base_url' | 'api_key' | 'context_window' | 'default_model' | 'fallback_order'>
    >,
  ): Promise<EndpointDoc | null> {
    return EndpointModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  /** Cache the discovered model list on the endpoint. */
  setModels(id: string | Types.ObjectId, models: string[]): Promise<EndpointDoc | null> {
    return EndpointModel.findByIdAndUpdate(
      id,
      { $set: { models, models_updated_at: new Date() } },
      { new: true },
    ).exec();
  },

  /** Promote one endpoint to default, demoting all others (single-default invariant). */
  async setDefault(id: string | Types.ObjectId): Promise<EndpointDoc | null> {
    await EndpointModel.updateMany({ _id: { $ne: id } }, { $set: { is_default: false } }).exec();
    return EndpointModel.findByIdAndUpdate(id, { $set: { is_default: true } }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<EndpointDoc | null> {
    return EndpointModel.findByIdAndDelete(id).exec();
  },
};
