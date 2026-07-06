import { Types } from 'mongoose';
import { ImageModel, type ImageDoc } from './image.model';

/** Build option inputs accepted on create/update (mirrors the Image schema). */
export interface ImageInput {
  name: string;
  description?: string;
  dockerfile?: string;
  build_args?: Array<{ key: string; value: string }>;
  no_cache?: boolean;
  pull?: boolean;
  build_timeout_ms?: number | null;
}

/** Data-access for Docker image entities. Thin wrapper over the Mongoose model. */
export const imageRepository = {
  list(): Promise<ImageDoc[]> {
    return ImageModel.find().sort({ name: 1 }).exec();
  },

  findById(id: string | Types.ObjectId): Promise<ImageDoc | null> {
    return ImageModel.findById(id).exec();
  },

  create(input: ImageInput): Promise<ImageDoc> {
    return ImageModel.create(input);
  },

  /** Patch a subset of fields (name/description/dockerfile/build-opts/build-state). */
  update(id: string | Types.ObjectId, patch: Record<string, unknown>): Promise<ImageDoc | null> {
    return ImageModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).exec();
  },

  delete(id: string | Types.ObjectId): Promise<ImageDoc | null> {
    return ImageModel.findByIdAndDelete(id).exec();
  },
};
