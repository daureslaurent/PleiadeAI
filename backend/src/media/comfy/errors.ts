/**
 * Failure taxonomy for the ComfyUI media path.
 *
 * Both classes are *operator-fixable* conditions, not bugs: the media tools catch them and return
 * `{ ok: false, error }` so the agent can read and relay the reason, exactly as `generate_image` used
 * to do with `ImageGenError`. Anything else thrown from this layer is a genuine defect and is allowed
 * to propagate.
 */

/** Configuration / connectivity / validation problem — nothing was (or could be) queued. */
export class ComfyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComfyError';
  }
}

/** ComfyUI accepted the job and a node then threw. Carries the node context ComfyUI reported. */
export class ComfyExecutionError extends ComfyError {
  readonly nodeId?: string;
  readonly nodeType?: string;
  readonly traceback?: string;

  constructor(message: string, ctx: { nodeId?: string; nodeType?: string; traceback?: string } = {}) {
    super(message);
    this.name = 'ComfyExecutionError';
    this.nodeId = ctx.nodeId;
    this.nodeType = ctx.nodeType;
    this.traceback = ctx.traceback;
  }
}

/**
 * Whether a ComfyUI exception is the GPU running out of memory. Worth singling out because this box
 * shares its 12GB card with the llama.cpp inference server, so it is the *expected* failure under
 * load rather than an exotic one — and the fix (retry when chat is idle, or shrink the job) is
 * something the agent can usefully say out loud.
 *
 * Covers stable-diffusion.cpp/ComfyUI's own `VRAM grow failed: N bytes` alongside the PyTorch
 * allocator's wording.
 */
export function isVramError(message: string): boolean {
  return /VRAM grow failed|out of memory|CUDA error: out of memory|CUDA out of memory/i.test(message);
}

/** Human-facing suffix appended to a VRAM failure, naming the actual cause on this deployment. */
export const VRAM_HINT =
  'The GPU ran out of VRAM. This ComfyUI box shares its card with the inference server — retry when ' +
  'chat is idle, or reduce the resolution / length / batch size.';
