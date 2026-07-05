import { createLogger } from '../../config/logger';
import { llamaClient } from '../../inference/LlamaClient';
import { resolveInference, resolveFallbacks } from '../../inference/inference-resolver';
import type { ChatMessage } from './jit-builder';
import type { AgentDoc } from './agent.model';
import { PRESET_HUES, ICON_KEYS, nearestPresetHue, isIconKey } from './identity.constants';

const log = createLogger('identity-suggester');

export interface SuggestedIdentity {
  /** One of `PRESET_HUES`. */
  color: number;
  /** One of `ICON_KEYS`. */
  icon: string;
}

const SYSTEM = [
  "You assign a visual identity to an AI agent so an operator can recognise it at a glance.",
  'Given the agent name and description, pick the single best-fitting color and icon.',
  '',
  `Allowed colors (HSL hue numbers): ${PRESET_HUES.join(', ')}.`,
  `Allowed icons (keys): ${ICON_KEYS.join(', ')}.`,
  '',
  'Choose an icon whose meaning matches the agent (e.g. a database agent -> "database", a web/search',
  'agent -> "globe" or "search", a coding agent -> "code" or "terminal", a security agent -> "shield").',
  'Pick a color that suits its role; use distinct hues for distinct kinds of work.',
  '',
  'Reply with ONLY a compact JSON object and nothing else, exactly:',
  '{"color": <hue>, "icon": "<key>"}',
].join('\n');

/**
 * One-shot LLM call suggesting a swatch hue + icon key for a (possibly not-yet-created) agent.
 * Mirrors `session-titler.ts`: runs on the fleet default endpoint with the configured fallbacks and
 * degrades gracefully — any failure or off-palette answer is snapped back onto the curated sets so
 * the caller always gets a valid, renderable identity.
 */
export async function suggestAgentIdentity(
  name: string,
  description: string,
): Promise<SuggestedIdentity> {
  // Deterministic fallback if the model is unreachable or replies with junk.
  const fallback: SuggestedIdentity = { color: PRESET_HUES[0], icon: 'bot' };

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Name: ${name}\nDescription: ${description || '(none)'}\n\nJSON:`,
      },
    ];

    // No agent yet (drafting) → resolve the fleet default endpoint + model.
    const inference = await resolveInference({ endpoint_id: null, model: '' } as Pick<
      AgentDoc,
      'endpoint_id' | 'model'
    >);
    const fallbacks = await resolveFallbacks(inference.url);

    const { text } = await llamaClient.streamChat(
      messages,
      [],
      { onToken: () => {} },
      undefined,
      { maxTokens: 512, temperature: 0.4 },
      inference,
      fallbacks,
    );

    return parseIdentity(text) ?? fallback;
  } catch (err) {
    log.warn({ err: String(err) }, 'identity suggestion failed');
    return fallback;
  }
}

/** Extract the first JSON object from the (possibly reasoning-wrapped) reply and snap it on-palette. */
function parseIdentity(raw: string): SuggestedIdentity | null {
  // Drop <think> reasoning blocks a reasoning model may emit before the answer.
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const match = cleaned.match(/\{[\s\S]*?\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const hue = typeof obj.color === 'number' ? obj.color : Number(obj.color);
  const color = Number.isFinite(hue) ? nearestPresetHue(hue) : PRESET_HUES[0];
  const icon = isIconKey(obj.icon) ? obj.icon : 'bot';
  return { color, icon };
}
