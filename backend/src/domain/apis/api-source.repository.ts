import { ApiSourceModel, type ApiSourceDoc } from './api-source.model';

/**
 * Data access for configured APIs. `secret_enc` is `select: false`, so every read here is
 * credential-free except {@link findByNameWithSecret} — which only the caller service uses.
 */
export const apiSourceRepository = {
  /**
   * Every configured API, credential included — the settings route needs to answer "is one stored"
   * (`has_secret`) and cannot do that from a document the ciphertext was projected out of. The route
   * strips `secret_enc` in its public projection, and `redact.ts`'s `_enc$` rule covers the slip.
   */
  list(): Promise<ApiSourceDoc[]> {
    return ApiSourceModel.find().select('+secret_enc').sort({ name: 1 }).exec();
  },

  /** What `api_man` sees: only APIs the operator has switched on. */
  listEnabled(): Promise<ApiSourceDoc[]> {
    return ApiSourceModel.find({ enabled: true }).sort({ name: 1 }).exec();
  },

  findById(id: string): Promise<ApiSourceDoc | null> {
    return ApiSourceModel.findById(id).exec();
  },

  findByName(name: string): Promise<ApiSourceDoc | null> {
    return ApiSourceModel.findOne({ name: name.toLowerCase() }).exec();
  },

  /** The read the caller service uses to build a request. */
  findByNameWithSecret(name: string): Promise<ApiSourceDoc | null> {
    return ApiSourceModel.findOne({ name: name.toLowerCase() }).select('+secret_enc').exec();
  },

  findByIdWithSecret(id: string): Promise<ApiSourceDoc | null> {
    return ApiSourceModel.findById(id).select('+secret_enc').exec();
  },

  create(patch: Record<string, unknown>): Promise<ApiSourceDoc> {
    return ApiSourceModel.create(patch);
  },

  /** Selects the credential for the same reason `list` does: the reply carries `has_secret`. */
  update(id: string, patch: Record<string, unknown>): Promise<ApiSourceDoc | null> {
    return ApiSourceModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).select('+secret_enc').exec();
  },

  delete(id: string): Promise<ApiSourceDoc | null> {
    return ApiSourceModel.findByIdAndDelete(id).exec();
  },

  /**
   * Record how the most recent call went — success included, since "no error recorded" cannot
   * distinguish a healthy API from one nobody has ever called.
   */
  async noteCall(id: string, call: Record<string, unknown>): Promise<void> {
    await ApiSourceModel.updateOne({ _id: id }, { $set: { last_call: { ...call, at: new Date() } } }).exec();
  },
};
