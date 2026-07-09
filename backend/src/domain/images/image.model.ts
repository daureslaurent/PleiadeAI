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

/**
 * Visual-desktop click calibration (see `tools/core/visual.ts`). A vision model reads pixel
 * coordinates a few px off (a consistent bias, worsened by the server's internal image resize), so
 * clicks land slightly off-target. Calibration measures that bias with synthetic on-screen targets
 * and fits a per-axis affine correction `x' = ax·x + bx`, `y' = ay·y + by` applied to every located
 * coordinate. Keyed by the vision model + resolution it was measured at — a mismatch is ignored and
 * re-calibration is prompted. Cleared on rebuild (the image, hence its desktop, may change).
 */
const VisualCalibrationSchema = new Schema(
  {
    /** Vision model id the bias was measured against; a different model ignores this calibration. */
    vision_model: { type: String, required: true },
    /** Desktop resolution it was measured at; a mismatch ignores this calibration. */
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    ax: { type: Number, required: true },
    bx: { type: Number, required: true },
    ay: { type: Number, required: true },
    by: { type: Number, required: true },
    /** Number of synthetic targets that were successfully located during the fit. */
    samples: { type: Number, default: 0 },
    /** Mean absolute pixel error before / after the fit — surfaced so the operator can judge it. */
    error_before: { type: Number, default: 0 },
    error_after: { type: Number, default: 0 },
    measured_at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ImageSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    dockerfile: { type: String, default: () => DEFAULT_DOCKERFILE },

    /**
     * Visual-desktop image: the Dockerfile is expected to include the visual layer (Xvfb + x11vnc +
     * xdotool/scrot/pyautogui, see `visual.template.ts`). Set from the "Visual desktop" toggle on the
     * Images page. Agents whose isolation profile references a visual image are auto-granted the
     * `visual_screenshot` / `visual_act` core tools (see `AgentRunner`), and the Dockerfile lint adds
     * the visual-layer checks. Purely declarative — the boot script's preflight remains authoritative.
     */
    visual: { type: Boolean, default: false },

    /**
     * Visual desktop resolution (the Xvfb/VNC screen size). Null → the boot script default
     * (1280×800). Injected as `PLEIADES_VISUAL_GEOMETRY=<w>x<h>x24` when the desktop boots, so a change
     * applies on the next desktop start (no rebuild). A change invalidates any click calibration.
     */
    visual_width: { type: Number, default: null },
    visual_height: { type: Number, default: null },

    /** Click calibration for this visual image's desktop (null until measured; cleared on rebuild). */
    visual_calibration: { type: VisualCalibrationSchema, default: null },

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
