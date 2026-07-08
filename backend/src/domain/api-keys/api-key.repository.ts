import type { Types } from 'mongoose';
import { ApiKeyModel, type ApiKeyDoc } from './api-key.model';

/**
 * Data access for `api_keys`. Kept thin — key generation, hashing and verification live in
 * `api-key.service.ts`, which is the only caller of {@link findByPrefixWithHash}.
 */
export const apiKeyRepository = {
  /** Newest first. `key_hash` is `select: false`, so this is always safe to shape for a client. */
  list(): Promise<ApiKeyDoc[]> {
    return ApiKeyModel.find().sort({ created_at: -1 }).exec();
  },

  /** Includes the hash. Only for verification, immediately before a timing-safe compare. */
  findByPrefixWithHash(prefix: string): Promise<ApiKeyDoc | null> {
    return ApiKeyModel.findOne({ prefix }).select('+key_hash').exec();
  },

  create(input: { name: string; prefix: string; key_hash: string }): Promise<ApiKeyDoc> {
    return ApiKeyModel.create(input);
  },

  /** Fire-and-forget liveness stamp. Throttled by the service; never blocks a request. */
  touch(id: string | Types.ObjectId): Promise<unknown> {
    return ApiKeyModel.updateOne({ _id: id }, { $set: { last_used_at: new Date() } }).exec();
  },

  /** Idempotent: re-revoking keeps the original timestamp. Returns null when the key is unknown. */
  revoke(id: string | Types.ObjectId): Promise<ApiKeyDoc | null> {
    return ApiKeyModel.findOneAndUpdate(
      { _id: id, revoked_at: null },
      { $set: { revoked_at: new Date() } },
      { new: true },
    )
      .exec()
      .then((doc) => doc ?? ApiKeyModel.findById(id).exec());
  },

  delete(id: string | Types.ObjectId): Promise<ApiKeyDoc | null> {
    return ApiKeyModel.findByIdAndDelete(id).exec();
  },
};
