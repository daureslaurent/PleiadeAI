import { createLogger } from '../../config/logger';
import { analyzeImageWithVision } from '../../inference/vision-analyze';
import type { Tool } from '../types';

const log = createLogger('tool:analyze_image');

/**
 * `analyze_image` — look at an image the user attached to this turn. Routes the image through the
 * operator-configured Vision endpoint (Settings → Vision endpoint) and returns a plain-text answer,
 * so a text-only agent can still "read" a dropped image. A multimodal agent also gets the raw pixels
 * in its context and may not need this. Emits `tool:vision` so the image + answer render in the chat.
 *
 * Only granted to a turn that actually has attached images (see AgentRunner).
 */
export const analyzeImage: Tool = {
  name: 'analyze_image',
  description:
    'Analyse an image available in this turn (attached by the user, or read/acquired by a tool). Pass ' +
    '`question` to ask about something specific ("what does this error say?", "describe the chart"); ' +
    'omit for a general description. Pick which image by its `image_id` handle (e.g. "img_1", shown ' +
    'when it was loaded) — or, for a user attachment, by 0-based `index`. Returns a text answer.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What to ask about the image. Omit for a general description + text transcription.',
      },
      image_id: {
        type: 'string',
        description: 'Handle of the image to analyse (e.g. "img_1"). Preferred over `index`.',
      },
      index: {
        type: 'integer',
        description: 'Which image to analyse by position (0 = first). Used only when `image_id` is omitted.',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    // Only actual images are analysable — blob resources (kind 'blob') carry no pixels.
    const images = (ctx.attachedImages ?? []).filter((i) => i.kind !== 'blob' && i.dataUrl);
    if (images.length === 0) {
      return { result: { ok: false, error: 'no image is available in this turn' } };
    }

    const imageId = args.image_id != null ? String(args.image_id).trim() : '';
    let img;
    let ref: string | number;
    if (imageId) {
      img = images.find((i) => i.id === imageId);
      ref = imageId;
      if (!img) {
        const known = images.map((i) => i.id).filter(Boolean).join(', ') || '(none have handles)';
        return { result: { ok: false, error: `no image with id "${imageId}" (available: ${known})` } };
      }
    } else {
      const index = Math.trunc(Number(args.index) || 0);
      img = images[index];
      ref = index;
      if (!img) {
        return { result: { ok: false, error: `index out of range (0..${images.length - 1})` } };
      }
    }

    const question = String(args.question ?? '');
    const dataUrl = img.dataUrl!; // guaranteed by the kind/dataUrl filter above
    const { analysis, model } = await analyzeImageWithVision(dataUrl, question);

    ctx.emitVision?.({ image: dataUrl, question, answer: analysis, model });
    log.info({ agent: ctx.agentName, ref, model: model || null }, 'analyze_image');

    return {
      result: {
        ok: true,
        image_id: img.id ?? null,
        image_count: images.length,
        analysis,
        ...(model ? { vision_model: model } : {}),
      },
    };
  },
};
