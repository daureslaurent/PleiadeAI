import { createLogger } from '../config/logger';
import { settingsService } from '../domain/settings/settings.service';
import { resolveForEndpoint } from './inference-resolver';

const log = createLogger('image-generate');

/**
 * CPU FLUX is slow (tens of seconds to minutes per image), so the image endpoint gets a much more
 * generous timeout than the chat/vision calls. A whole `generate_image` tool call is bounded by this.
 */
const REQUEST_TIMEOUT_MS = 8 * 60_000;

/** Thrown when generation can't proceed for an operator-fixable reason (no endpoint, server error). */
export class ImageGenError extends Error {}

export interface ImageGenParams {
  prompt: string;
  negativePrompt?: string;
  /** OpenAI-style dimension string, e.g. `768x768`. */
  size?: string;
  /** Number of images to produce in one call. */
  n?: number;
  /** Sampling steps (FLUX.1-dev wants ~20-28; schnell ~4). */
  steps?: number;
  /** Distilled-guidance scale (FLUX.1-dev ~3.5). This is NOT real CFG. */
  guidance?: number;
  /**
   * Real classifier-free-guidance scale. FLUX.1-dev is guidance-*distilled* and must run with real CFG
   * OFF (1.0) — any value > 1 makes it run an unconditional pass it was never trained for, producing
   * burnt / oversaturated / banded output and ~2x the compute. Only raise this on a non-distilled model.
   * Defaults to 1.0 (off). A negative prompt is only sent when this is > 1, since it's a no-op otherwise.
   */
  cfgScale?: number;
  /** RNG seed for reproducibility (negative → random; omitted → the server's default seed). */
  seed?: number;
}

export interface ImageGenResult {
  /** Generated images as `data:image/png;base64,...` URLs. */
  images: string[];
  /** The image model id used (from the endpoint), or '' when unknown. */
  model: string;
  /** Normalized endpoint base URL the request went to. */
  endpoint: string;
}

/** Shape of the OpenAI-compatible `/v1/images/generations` response (as served by sd-server). */
interface ImagesResponse {
  data?: { b64_json?: string; url?: string }[];
}

/**
 * Native stable-diffusion.cpp generation params (the `sdcpp API` request schema — see
 * `examples/server/api.md`). Only the fields we actually drive; everything else keeps the server's
 * CLI defaults.
 */
interface SdCppExtraArgs {
  negative_prompt?: string;
  seed?: number;
  sample_params: {
    sample_method: string;
    sample_steps?: number;
    guidance: {
      /** REAL classifier-free guidance (the server calls it txt_cfg; `--cfg-scale` on the CLI). */
      txt_cfg?: number;
      /** FLUX's distilled guidance (`--guidance` on the CLI). A different knob from txt_cfg. */
      distilled_guidance?: number;
    };
  };
}

/**
 * FLUX wants plain `euler`, not the SD-era `euler_a` that sd-server defaults to (upstream
 * `docs/flux.md` uses `--sampling-method euler` in every FLUX example).
 */
const SAMPLE_METHOD = 'euler';

/**
 * sd-server's OpenAI route is a thin compatibility shim: it reads **only** `prompt`, `n`, `size`,
 * `output_format` and `output_compression` from the body and drops everything else on the floor
 * (`examples/server/routes_openai.cpp`). Steps, samplers, seeds, negative prompts and both guidance
 * scales are reachable only through the native schema, which the OpenAI route accepts as a JSON blob
 * embedded in the prompt inside an `<sd_cpp_extra_args>` tag — the server extracts it, applies it,
 * and strips it from the text before generating (`examples/server/api.md` §sd_cpp_extra_args).
 *
 * So: send them that way, or silently inherit the server's CLI defaults (which include a real CFG of
 * **7.0** — the value that burns FLUX-dev).
 */
function embedExtraArgs(prompt: string, args: SdCppExtraArgs): string {
  return `${prompt} <sd_cpp_extra_args>${JSON.stringify(args)}</sd_cpp_extra_args>`;
}

/**
 * Generate one or more images via the operator-configured **Image endpoint** (Settings → Image
 * endpoint) — an OpenAI-compatible `POST /v1/images/generations` server such as the bundled
 * `image-gen/` stable-diffusion.cpp box running FLUX. Mirrors `vision-analyze` in shape: resolve the
 * endpoint from Settings, call it, return a plain result. Throws {@link ImageGenError} when no endpoint
 * is configured, it no longer exists, or the server responds with an error / no image.
 */
export async function generateImages(params: ImageGenParams): Promise<ImageGenResult> {
  const settings = await settingsService.get();
  if (!settings.image_endpoint_id) {
    throw new ImageGenError(
      'No Image endpoint is configured. Set one in Settings → Image endpoint (an OpenAI-compatible ' +
        'image server such as the bundled image-gen/ FLUX box).',
    );
  }
  const target = await resolveForEndpoint(settings.image_endpoint_id, settings.image_model);
  if (!target) {
    throw new ImageGenError(
      'The configured Image endpoint no longer exists. Pick a valid one in Settings → Image endpoint.',
    );
  }

  // The endpoint's base_url is stored without the `/v1` suffix (the chat client adds it); do the same
  // here for the images route.
  const base = target.url.replace(/\/+$/, '');
  const url = `${base}/v1/images/generations`;

  // Distilled guidance and real CFG are DIFFERENT knobs. On FLUX.1-dev the distilled guidance (~3.5)
  // shapes the image; real CFG (`txt_cfg`) must stay at 1.0 (off) or the distilled model burns out.
  // Send them as separate values — never mirror guidance onto txt_cfg (that was the "ugly output" bug).
  const cfgScale = params.cfgScale ?? 1;
  const extra: SdCppExtraArgs = {
    sample_params: {
      sample_method: SAMPLE_METHOD,
      guidance: { txt_cfg: cfgScale },
    },
  };
  if (params.steps !== undefined) extra.sample_params.sample_steps = params.steps;
  if (params.guidance !== undefined) extra.sample_params.guidance.distilled_guidance = params.guidance;
  // A negative prompt only does anything when real CFG is on (txt_cfg > 1). Sending it at cfg 1.0 is
  // a pure no-op on FLUX, so only include it when CFG is actually engaged.
  if (cfgScale > 1 && params.negativePrompt) extra.negative_prompt = params.negativePrompt;
  // sd-server's own default seed is a FIXED 42 (`--seed`, "use random seed for < 0"), so omitting the
  // seed doesn't mean "random" — it means the same prompt returns byte-identical images forever.
  // Default to -1 so each call is a fresh draw unless the caller pins a seed.
  extra.seed = params.seed ?? -1;

  // OpenAI-shaped body. Only prompt/n/size/output_format survive the compat route (see
  // embedExtraArgs) — every other knob rides inside the prompt tag.
  const body: Record<string, unknown> = {
    prompt: embedExtraArgs(params.prompt, extra),
    n: params.n ?? 1,
    output_format: 'png',
  };
  if (params.size) body.size = params.size;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'is unreachable';
    throw new ImageGenError(
      `The Image endpoint ${reason} (${url}). CPU image generation is slow — check the server is up ` +
        `and, if this recurs, that the model isn't still loading.`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new ImageGenError(`Image endpoint returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const json = (await res.json().catch(() => ({}))) as ImagesResponse;
  const images = (json.data ?? [])
    .map((d) => {
      if (d.b64_json) return `data:image/png;base64,${d.b64_json}`;
      // A data: URL is directly usable; a remote/file URL isn't reachable from here, so skip it.
      if (d.url?.startsWith('data:')) return d.url;
      return null;
    })
    .filter((u): u is string => Boolean(u));

  if (images.length === 0) {
    throw new ImageGenError(
      'The Image endpoint returned no image. If the model was just loaded it may still be warming up; ' +
        'otherwise check the server logs.',
    );
  }

  log.info(
    { endpoint: base, model: target.model, count: images.length, ms: Date.now() - startedAt },
    'generated image(s)',
  );
  return { images, model: target.model, endpoint: base };
}
