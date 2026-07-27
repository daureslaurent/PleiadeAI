import { Types } from 'mongoose';
import { AndroidDeviceModel, type AndroidDeviceDoc } from './android-device.model';

/** Data-access for the registered Android devices. Thin; readiness/probing lives in the tools. */
export const androidDeviceRepository = {
  list(): Promise<AndroidDeviceDoc[]> {
    return AndroidDeviceModel.find().sort({ name: 1 }).exec();
  },

  /** Enabled devices only — what the agent form offers and what the tools will talk to. */
  listEnabled(): Promise<AndroidDeviceDoc[]> {
    return AndroidDeviceModel.find({ enabled: true }).sort({ name: 1 }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<AndroidDeviceDoc | null> {
    return AndroidDeviceModel.findById(id).exec();
  },

  create(input: {
    name: string;
    adb_host: string;
    adb_port?: number;
    description?: string;
    enabled?: boolean;
  }): Promise<AndroidDeviceDoc> {
    return AndroidDeviceModel.create(input);
  },

  update(
    id: string | Types.ObjectId,
    patch: Partial<
      Pick<
        AndroidDeviceDoc,
        | 'name'
        | 'description'
        | 'adb_host'
        | 'adb_port'
        | 'mirror_max_size'
        | 'mirror_bit_rate'
        | 'mirror_max_fps'
        | 'enabled'
        | 'last_status'
        | 'last_error'
        | 'last_checked_at'
        | 'last_seen_model'
      >
    >,
  ): Promise<AndroidDeviceDoc | null> {
    return AndroidDeviceModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<AndroidDeviceDoc | null> {
    return AndroidDeviceModel.findByIdAndDelete(id).exec();
  },
};
