import { Types } from 'mongoose';
import { IsolationModel, type IsolationDoc } from './isolation.model';

/** Data-access for isolation profiles. Thin wrapper over the Mongoose model. */
export const isolationRepository = {
  list(): Promise<IsolationDoc[]> {
    return IsolationModel.find().sort({ name: 1 }).exec();
  },

  /** Profiles that reference a given image (used to fan out container recreation on rebuild). */
  listByImage(imageId: string | Types.ObjectId): Promise<IsolationDoc[]> {
    return IsolationModel.find({ image_id: imageId }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<IsolationDoc | null> {
    return IsolationModel.findById(id).exec();
  },

  /** Fetch including the `select: false` encrypted SSH key (for container provisioning only). */
  findByIdWithSsh(id: string | Types.ObjectId): Promise<IsolationDoc | null> {
    return IsolationModel.findById(id).select('+ssh_private_key_enc').exec();
  },

  /** Fetch including the `select: false` encrypted WireGuard `.conf` (for gluetun provisioning only). */
  findByIdWithVpn(id: string | Types.ObjectId): Promise<IsolationDoc | null> {
    return IsolationModel.findById(id).select('+vpn_conf_enc').exec();
  },

  /** Whether a profile currently has an SSH private key set (non-secret boolean for status). */
  async hasSshKey(id: string | Types.ObjectId): Promise<boolean> {
    const doc = await IsolationModel.findById(id).select('+ssh_private_key_enc').lean().exec();
    return Boolean(doc?.ssh_private_key_enc);
  },

  /** Whether a profile has a WireGuard `.conf` set (non-secret boolean for status). */
  async hasVpnConf(id: string | Types.ObjectId): Promise<boolean> {
    const doc = await IsolationModel.findById(id).select('+vpn_conf_enc').lean().exec();
    return Boolean(doc?.vpn_conf_enc);
  },

  /** Fetch including the `select: false` encrypted remote sudo password (for provisioning only). */
  findByIdWithSudo(id: string | Types.ObjectId): Promise<IsolationDoc | null> {
    return IsolationModel.findById(id).select('+sudo_password_enc').exec();
  },

  /** Whether a profile has a remote sudo password set (non-secret boolean for status). */
  async hasSudoPassword(id: string | Types.ObjectId): Promise<boolean> {
    const doc = await IsolationModel.findById(id).select('+sudo_password_enc').lean().exec();
    return Boolean(doc?.sudo_password_enc);
  },

  create(input: {
    name: string;
    description?: string;
    image_id?: string | null;
    cpus?: string;
    memory?: string;
    network?: string;
    idle_timeout_ms?: number;
    vpn_conf_enc?: string | null;
    sudo_password_enc?: string | null;
  }): Promise<IsolationDoc> {
    return IsolationModel.create(input);
  },

  /** Patch a subset of fields (name/description/dockerfile/resources/build-state). */
  update(id: string | Types.ObjectId, patch: Record<string, unknown>): Promise<IsolationDoc | null> {
    return IsolationModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<IsolationDoc | null> {
    return IsolationModel.findByIdAndDelete(id).exec();
  },
};
