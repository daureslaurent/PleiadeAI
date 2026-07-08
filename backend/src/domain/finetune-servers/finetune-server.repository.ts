import { Types } from 'mongoose';
import { FinetuneServerModel, type FinetuneServerDoc } from './finetune-server.model';

/**
 * Data-access for remote fine-tune servers. Kept thin; the proxy logic lives in the service.
 *
 * `api_key_enc` is `select: false`, so it is absent from every read here except
 * {@link findByIdWithKey} — the one path the proxy uses just before an outbound call.
 */
export const finetuneServerRepository = {
  list(): Promise<FinetuneServerDoc[]> {
    return FinetuneServerModel.find().sort({ name: 1 }).exec();
  },

  /** Enabled servers only — what the FineTuning page shows and the poller talks to. */
  listEnabled(): Promise<FinetuneServerDoc[]> {
    return FinetuneServerModel.find({ enabled: true }).sort({ name: 1 }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<FinetuneServerDoc | null> {
    return FinetuneServerModel.findById(id).exec();
  },

  /** Includes the encrypted key. Only for the proxy service, immediately before an outbound call. */
  findByIdWithKey(id: string | Types.ObjectId): Promise<FinetuneServerDoc | null> {
    return FinetuneServerModel.findById(id).select('+api_key_enc').exec();
  },

  findByName(name: string): Promise<FinetuneServerDoc | null> {
    return FinetuneServerModel.findOne({ name }).exec();
  },

  create(input: {
    name: string;
    base_url: string;
    api_key_enc?: string | null;
    enabled?: boolean;
  }): Promise<FinetuneServerDoc> {
    return FinetuneServerModel.create(input);
  },

  update(
    id: string | Types.ObjectId,
    patch: Partial<Pick<FinetuneServerDoc, 'name' | 'base_url' | 'api_key_enc' | 'enabled'>>,
  ): Promise<FinetuneServerDoc | null> {
    return FinetuneServerModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<FinetuneServerDoc | null> {
    return FinetuneServerModel.findByIdAndDelete(id).exec();
  },
};
