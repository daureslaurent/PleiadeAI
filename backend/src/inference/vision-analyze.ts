import { settingsService, type EffectiveSettings } from '../domain/settings/settings.service';
import { resolveForEndpoint } from './inference-resolver';
import { llamaClient } from './LlamaClient';
import type { ChatMessage } from '../domain/agents/jit-builder';

/**
 * Translate the operator's vision sampling settings into `llamaClient.complete` opts. A `null` setting
 * means "disabled" → we pass `undefined` so the field is omitted from the request and the server uses
 * its own default. Shared by `analyze_image` and `visual_screenshot`.
 */
export function visionSamplingOpts(s: EffectiveSettings): {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
} {
  const n = (v: number | null): number | undefined => (v == null ? undefined : v);
  return {
    maxTokens: n(s.vision_max_tokens),
    temperature: n(s.vision_temperature),
    topP: n(s.vision_top_p),
    frequencyPenalty: n(s.vision_frequency_penalty),
    presencePenalty: n(s.vision_presence_penalty),
  };
}

/**
 * Shared "analyse an image with the operator-configured Vision endpoint" helper (Settings → Vision
 * endpoint). Used by the `analyze_image` tool for user-attached images. `visual_screenshot` keeps its
 * own grid/localization logic, but shares the same underlying `llamaClient.complete` + endpoint.
 */
export interface VisionResult {
  analysis: string;
  /** Vision model id that produced the answer, or '' when none was available. */
  model: string;
}

const NO_ENDPOINT =
  'No Vision endpoint is configured, so this image could not be analysed. Configure one in Settings → Vision endpoint (an endpoint whose model supports vision).';
const GONE_ENDPOINT =
  'The configured Vision endpoint no longer exists. Pick a valid one in Settings → Vision endpoint.';

/**
 * A vision model that returns almost nothing after an image usually isn't "seeing" it — the classic
 * cause is a **mismatched/wrong mmproj** for the model (or a bad chat template) on the Vision endpoint.
 * Append a diagnostic so the operator sees it in the chat, not just the backend logs.
 */
export function annotateIfDegenerate(analysis: string, model: string): string {
  const meaningful = analysis.replace(/[^A-Za-z0-9]/g, '').length;
  if (model && meaningful < 12) {
    return (
      `${analysis}\n\n[Vision warning: the vision model returned almost nothing for this image. ` +
      `This usually means the Vision endpoint is misconfigured — most often the mmproj file does not ` +
      `match the model (e.g. a 30B mmproj left in place after switching to a 7B model). Verify the ` +
      `endpoint's model + mmproj pairing.]`
    );
  }
  return analysis;
}

/** Analyse an image (a `data:` URL) with the Vision endpoint; returns plain text + the model id. */
export async function analyzeImageWithVision(dataUrl: string, question: string): Promise<VisionResult> {
  const settings = await settingsService.get();
  if (!settings.vision_endpoint_id) return { analysis: NO_ENDPOINT, model: '' };
  const target = await resolveForEndpoint(settings.vision_endpoint_id, settings.vision_model);
  if (!target) return { analysis: GONE_ENDPOINT, model: '' };

  const ask =
    question.trim() ||
    'Describe this image in detail: transcribe any visible text and note the key elements.';
  const prompt =
    `${ask}\n\nAnswer in plain text. Be concise and factual; transcribe visible text accurately, ` +
    `do not invent content, and do not repeat yourself.`;
  // Qwen2.5-VL (and most VL models) are trained image-FIRST, then the question — the server inserts
  // the vision tokens at the image part's position, so ordering it before the text matches training.
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant that looks at images and answers accurately.' },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt },
      ],
    },
  ];
  try {
    const analysis = (await llamaClient.complete(target, messages, visionSamplingOpts(settings))).trim();
    return {
      analysis: annotateIfDegenerate(analysis || '(the vision model returned no text)', target.model),
      model: target.model,
    };
  } catch (err) {
    return {
      analysis: `vision analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      model: target.model,
    };
  }
}
