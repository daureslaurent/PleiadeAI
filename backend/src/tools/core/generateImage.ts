import { createLogger } from '../../config/logger';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import { generateImages, ImageGenError } from '../../inference/image-generate';
import type { ImageBlock } from '../../core/event-bus/events.types';
import type { Tool, ToolConfigField } from '../types';

const log = createLogger('tool:generate_image');

/** Hard ceiling on images per call — one slow FLUX call shouldn't be able to queue dozens. */
const MAX_N = 4;

/**
 * Operator-tunable generation settings, rendered on the Tools page. These are the *only* place the
 * generation parameters are set — the agent supplies just a `prompt` and every other knob (size,
 * count, steps, guidance, negative prompt) comes from here. FLUX.1-dev-friendly defaults.
 */
const CONFIG_SCHEMA: ToolConfigField[] = [
  {
    key: 'default_size',
    label: 'Size',
    type: 'select',
    options: ['1024x1024', '1024x768', '768x1024', '768x768', '512x512'],
    default: '1024x1024',
    hint: 'Image dimensions. FLUX is trained at ~1 megapixel — 1024x1024 is sharp; 512/768 come out soft/blurry. Larger is slower.',
  },
  {
    key: 'default_steps',
    label: 'Steps (cycles)',
    type: 'number',
    default: 24,
    hint: 'Sampling steps/cycles. FLUX.1-dev wants ~20-28 for crisp detail; schnell only ~4.',
  },
  {
    key: 'default_guidance',
    label: 'Guidance (distilled)',
    type: 'number',
    default: 3.5,
    hint: 'FLUX distilled-guidance scale (~3.5). This shapes the image and is NOT real CFG — leave it here.',
  },
  {
    key: 'default_cfg_scale',
    label: 'Real CFG',
    type: 'number',
    default: 1,
    hint: 'Classifier-free-guidance scale. FLUX.1-dev is guidance-distilled and must stay at 1 (off) — ' +
      'raising it burns/oversaturates the image and doubles the time. Only increase on a non-distilled ' +
      'model. The negative prompt only takes effect when this is > 1.',
  },
  {
    key: 'default_n',
    label: 'Count',
    type: 'number',
    default: 1,
    hint: `How many images per generation (max ${MAX_N}).`,
  },
  {
    key: 'default_negative_prompt',
    label: 'Negative prompt',
    type: 'string',
    default: '',
    hint: 'What to avoid in every image. FLUX is guidance-distilled, so this is a no-op unless Real CFG ' +
      'is set > 1 (which itself degrades FLUX-dev). Leave blank on FLUX.',
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
    'vivid, detailed `prompt` (subject, style, lighting, composition) — that is the only input. Size, ' +
    'count, steps, guidance and negative prompt are fixed by the operator on the Tools page and are ' +
    'not chosen per call. The image is saved as an `img_N` resource you can then save to a file ' +
    '(`write`/`data`) or hand to another agent. Generation can take a while.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to depict — be specific about subject, style, lighting, and composition.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  configSchema: CONFIG_SCHEMA,

  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { result: { ok: false, error: 'prompt is required' } };

    // Every generation parameter comes from the operator's Tools-page config — the agent only
    // supplies the prompt. No seed knob (kept simple): `generateImages` sends -1, i.e. a random draw
    // per call — leaving it unset would inherit sd-server's fixed default seed and repeat the image.
    const { config } = await toolConfigService.resolve(generateImage.name, CONFIG_SCHEMA);

    const size = String(config.default_size);
    const n = clampInt(config.default_n, 1, MAX_N, 1);
    const steps = clampInt(config.default_steps, 1, 150, 20);
    const guidance = Number(config.default_guidance);
    // Older tool configs predate this knob — default to 1 (real CFG off) so FLUX-dev stays un-burnt.
    const cfgScaleRaw = Number(config.default_cfg_scale);
    const cfgScale = Number.isFinite(cfgScaleRaw) ? cfgScaleRaw : 1;
    const negativePrompt = String(config.default_negative_prompt ?? '').trim() || undefined;
    const seed = undefined;

    log.info({ agent: ctx.agentName, size, n, steps, cfgScale }, 'generate_image');

    let out;
    try {
      out = await generateImages({ prompt, negativePrompt, size, n, steps, guidance, cfgScale, seed });
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
