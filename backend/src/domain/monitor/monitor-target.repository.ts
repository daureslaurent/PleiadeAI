import { Types } from 'mongoose';
import { MonitorTargetModel, type MonitorTargetDoc } from './monitor-target.model';

/**
 * Data-access for monitored machines. Thin by design; polling and threshold logic live in
 * `monitor.poller` / `monitor.alerts`.
 *
 * `api_key_enc` is `select: false`, so it is absent from every read except {@link findByIdWithKey}
 * and {@link listEnabledWithKeys} — the two paths that immediately make an outbound call.
 */
export const monitorTargetRepository = {
  list(): Promise<MonitorTargetDoc[]> {
    return MonitorTargetModel.find().sort({ name: 1 }).exec();
  },

  /** Enabled targets only — what the poller walks and the dashboard shows. */
  listEnabled(): Promise<MonitorTargetDoc[]> {
    return MonitorTargetModel.find({ enabled: true }).sort({ name: 1 }).exec();
  },

  /** Poller variant: one query per tick, keys included, instead of N key lookups. */
  listEnabledWithKeys(): Promise<MonitorTargetDoc[]> {
    return MonitorTargetModel.find({ enabled: true }).select('+api_key_enc').sort({ name: 1 }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<MonitorTargetDoc | null> {
    return MonitorTargetModel.findById(id).exec();
  },

  findByIdWithKey(id: string | Types.ObjectId): Promise<MonitorTargetDoc | null> {
    return MonitorTargetModel.findById(id).select('+api_key_enc').exec();
  },

  create(input: {
    name: string;
    base_url: string;
    api_key_enc?: string | null;
    endpoint_id?: string | Types.ObjectId | null;
    enabled?: boolean;
    note?: string;
  }): Promise<MonitorTargetDoc> {
    return MonitorTargetModel.create(input);
  },

  update(
    id: string | Types.ObjectId,
    patch: Partial<Pick<MonitorTargetDoc, 'name' | 'base_url' | 'api_key_enc' | 'endpoint_id' | 'enabled' | 'note'>>,
  ): Promise<MonitorTargetDoc | null> {
    return MonitorTargetModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<MonitorTargetDoc | null> {
    return MonitorTargetModel.findByIdAndDelete(id).exec();
  },
};
