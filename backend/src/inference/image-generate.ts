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
  /** Sampling steps (FLUX.1-dev wants ~20-28; schnell ~4). Best-effort — depends on the server build. */
  steps?: number;
  /** Guidance / CFG scale (FLUX.1-dev ~3.5). Best-effort — depends on the server build. */
  guidance?: number;
  /** RNG seed for reproducibility (-1 / omitted → random). Best-effort. */
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

  // OpenAI-shaped body + the stable-diffusion.cpp extensions. Unknown fields are ignored by servers
  // that don't support them, so the extras degrade gracefully across builds.
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    n: params.n ?? 1,
    response_format: 'b64_json',
  };
  if (params.size) body.size = params.size;
  if (params.negativePrompt) body.negative_prompt = params.negativePrompt;
  if (params.steps !== undefined) body.steps = params.steps;
  if (params.guidance !== undefined) {
    // Different sd-server builds read the FLUX distilled-guidance value under different keys — send both.
    body.cfg_scale = params.guidance;
    body.guidance = params.guidance;
  }
  if (params.seed !== undefined) body.seed = params.seed;

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
