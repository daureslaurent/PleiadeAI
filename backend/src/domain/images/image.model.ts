import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DEFAULT_DOCKERFILE } from '../../isolation/dockerfile.template';

/**
 * `images` collection — a first-class Docker image built from an operator-authored Dockerfile.
 *
 * Decoupled from isolation *profiles*: an Image owns only the Dockerfile + build options + build
 * lifecycle. Isolation profiles reference an Image via `image_id` and layer the runtime policy
 * (cpus/memory/network/VPN/SSH/…) on top. One Image can back several profiles, and its docker tag
 * is derived from its `_id` (`imgImageName`) so it's stable and collision-free.
 *
 * Builds run in the background, serialised through the in-process `buildManager` (one `docker build`
 * at a time). `image_status` reflects that queue: `queued` → `building` → `built` | `error`.
 */
const BuildArgSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    value: { type: String, default: '' },
  },
  { _id: false },
);

const ImageSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    dockerfile: { type: String, default: () => DEFAULT_DOCKERFILE },

    // Build options, forwarded to `docker build`.
    build_args: { type: [BuildArgSchema], default: [] },
    /** `--no-cache`: ignore the layer cache for a clean rebuild. */
    no_cache: { type: Boolean, default: false },
    /** `--pull`: always re-fetch the base image (`FROM`) even if present locally. */
    pull: { type: Boolean, default: false },
    /**
     * Hard wall-clock timeout for `docker build`, in ms. Null → fall back to the server default
     * (`AGENT_BUILD_TIMEOUT_MS`). Raise it for slow builds (large `apt`/`pip`/`npm` installs); on
     * expiry the build is killed and marked `error`.
     */
    build_timeout_ms: { type: Number, default: null },

    // Build lifecycle (driven by the manual Build action via `buildManager`).
    image_status: {
      type: String,
      enum: ['none', 'queued', 'building', 'built', 'error'],
      default: 'none',
    },
    image_built_at: { type: Date, default: null },
    last_build_error: { type: String, default: null },
    /** Size in bytes of the built image (from `docker inspect`), or null when never built. */
    image_size: { type: Number, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'images',
  },
);

export type Image = InferSchemaType<typeof ImageSchema>;
export type ImageDoc = HydratedDocument<Image>;

export const ImageModel = model('Image', ImageSchema);
