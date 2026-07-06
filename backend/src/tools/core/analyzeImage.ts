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
    'Analyse an image the user attached to this message. Pass `question` to ask about something ' +
    'specific ("what does this error say?", "describe the chart"); omit for a general description. ' +
    'Use `index` (0-based) to pick which attachment when several were sent. Returns a text answer.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What to ask about the image. Omit for a general description + text transcription.',
      },
      index: {
        type: 'integer',
        description: 'Which attached image to analyse (0 = first). Default 0.',
      },
    },
    additionalProperties: false,
  },

  async execute(args, ctx) {
    const images = ctx.attachedImages ?? [];
    if (images.length === 0) {
      return { result: { ok: false, error: 'no image is attached to this message' } };
    }
    const index = Math.trunc(Number(args.index) || 0);
    const img = images[index];
    if (!img) {
      return {
        result: { ok: false, error: `index out of range (0..${images.length - 1})` },
      };
    }
    const question = String(args.question ?? '');
    const { analysis, model } = await analyzeImageWithVision(img.dataUrl, question);

    ctx.emitVision?.({ image: img.dataUrl, question, answer: analysis, model });
    log.info({ agent: ctx.agentName, index, model: model || null }, 'analyze_image');

    return {
      result: {
        ok: true,
        index,
        image_count: images.length,
        analysis,
        ...(model ? { vision_model: model } : {}),
      },
    };
  },
};
