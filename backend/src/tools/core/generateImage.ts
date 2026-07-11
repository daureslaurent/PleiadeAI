import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { generateImages, ImageGenError } from '../../inference/image-generate';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:generate_image');

/** Hard ceiling on images per call — one slow FLUX call shouldn't be able to queue dozens. */
const MAX_N = 4;

/**
 * Operator-tunable defaults, rendered on the Tools page. The LLM may override any of these per call;
 * when it omits a field, the value here is used. FLUX.1-dev-friendly defaults (balanced quality/speed).
 */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'default_size',
    label: 'Default size',
    type: 'select',
    options: ['512x512', '768x768', '1024x1024', '1024x768', '768x1024'],
    default: '768x768',
    hint: 'Image dimensions when the model doesn’t specify one. Larger is dramatically slower on CPU.',
  },
  {
    key: 'default_steps',
    label: 'Default steps',
    type: 'number',
    default: 20,
    hint: 'Sampling steps when unspecified. FLUX.1-dev wants ~20-28; schnell only ~4.',
  },
  {
    key: 'default_guidance',
    label: 'Default guidance',
    type: 'number',
    default: 3.5,
    hint: 'CFG / distilled-guidance scale when unspecified. ~3.5 suits FLUX.1-dev.',
  },
  {
    key: 'default_n',
    label: 'Default count',
    type: 'number',
    default: 1,
    hint: `How many images per call when unspecified (max ${MAX_N}).`,
  },
];

/** Clamp to a finite integer in [min, max]; falls back to `def` when the value isn't a number. */
function clampInt(value: unknown, min: number, max: number, def: number): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * `generate_image` — create an image from a text prompt via the operator-configured Image endpoint
 * (Settings → Image endpoint; an OpenAI-compatible server such as the bundled `image-gen/` FLUX box).
 * The result is saved to the session resource pool (an `img_N` handle the agent can `write`/forward),
 * rendered as a generation card in the chat, and folded into a multimodal agent's context. Opt-in per
 * agent via `tools_allowed`.
 */
export const generateImage: Tool = {
  name: 'generate_image',
  description:
    'Generate an image from a text description using the configured image model (e.g. FLUX). Give a ' +
    'vivid, detailed `prompt` (subject, style, lighting, composition). Optional: `size` (e.g. ' +
    '"1024x1024"), `n` (count, max ' +
    MAX_N +
    '), `negative_prompt` (what to avoid), `steps`, `seed` (for a reproducible image), `guidance`. ' +
    'The image is saved as an `img_N` resource you can then save to a file (`write`/`data`) or hand ' +
    'to another agent. Generation can take a while on CPU.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to depict — be specific about subject, style, lighting, and composition.',
      },
      size: {
        type: 'string',
        description: 'Image dimensions as "WIDTHxHEIGHT" (e.g. "1024x1024"). Omit to use the default.',
      },
      n: {
        type: 'integer',
        description: `How many images to generate (1-${MAX_N}). Omit for the default.`,
      },
      negative_prompt: {
        type: 'string',
        description: 'What to avoid in the image (e.g. "blurry, text, watermark"). Optional.',
      },
      steps: {
        type: 'integer',
        description: 'Sampling steps. More = slower, potentially more detailed. Omit for the default.',
      },
      seed: {
        type: 'integer',
        description: 'RNG seed for a reproducible result. Omit for a random image each time.',
      },
      guidance: {
        type: 'number',
        description: 'Guidance / CFG scale (how closely to follow the prompt). Omit for the default.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { result: { ok: false, error: 'prompt is required' } };

    const { config } = await toolConfigService.resolve(generateImage.name, CONFIG_SCHEMA);

    const size = args.size ? String(args.size).trim() : String(config.default_size);
    const n = clampInt(args.n ?? config.default_n, 1, MAX_N, 1);
    const steps =
      args.steps !== undefined ? clampInt(args.steps, 1, 150, Number(config.default_steps)) : Number(config.default_steps);
    const guidance = args.guidance !== undefined ? Number(args.guidance) : Number(config.default_guidance);
    const negativePrompt = args.negative_prompt ? String(args.negative_prompt).trim() : undefined;
    const seed = args.seed !== undefined && Number.isFinite(Number(args.seed)) ? Math.trunc(Number(args.seed)) : undefined;

    log.info({ agent: ctx.agentName, size, n, steps }, 'generate_image');

    let out;
    try {
      out = await generateImages({ prompt, negativePrompt, size, n, steps, guidance, seed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Config/server problems are expected failure modes — return them as a normal tool error the
      // agent can read and relay, not a thrown exception.
      if (err instanceof ImageGenError) return { result: { ok: false, error: message } };
      throw err;
    }

    // Hand the pixels back as image resources: the runner pools them (assigning img_N handles),
    // persists them to the resource store, and folds them into a multimodal agent's context.
    const images: ImageBlock[] = out.images.map((dataUrl) => ({ dataUrl, kind: 'image', source: 'tool' }));

    // Emit the dedicated generation card (prompt + effective params + model) for the chat/debugger.
    ctx.emitImageGen?.({
      prompt,
      size,
      n,
      steps,
      guidance,
      seed: seed ?? null,
      negativePrompt: negativePrompt ?? null,
      model: out.model,
      count: images.length,
    });

    return {
      result: {
        ok: true,
        count: images.length,
        prompt,
        size,
        steps,
        guidance,
        ...(seed !== undefined ? { seed } : {}),
        ...(out.model ? { model: out.model } : {}),
      },
      images,
    };
  },
};
