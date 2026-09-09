/**
 * Shared policy for the "look at a screen" tools (`visual_screenshot`, `android_screenshot`).
 *
 * Both capture a frame and, historically, always routed it through the operator-configured **Vision
 * endpoint** — handing the calling agent a second-hand *description* of its own screen. That is the
 * right shape for a text-only agent, and strictly lossy for a multimodal one: the runner already
 * feeds tool-returned images to a vision-capable agent as raw pixels (see `AgentRunner`'s
 * `supportsVision` gate), and `analyze_image` is withheld from such agents for exactly this reason —
 * a weaker second model paraphrasing what the agent could read itself.
 *
 * So describe/read mode now asks: can the *calling* agent see? If yes, skip the Vision endpoint and
 * hand back the frame itself. Localization is deliberately NOT covered here — reading a pixel
 * coordinate off a screen is a separate capability from accepting an image, and the desktop's grid +
 * OCR-snap + affine calibration pipeline stays on the Vision endpoint regardless.
 *
 * Two operator knobs, shared verbatim by both tools so the behaviour is one concept:
 *  - `screen_analysis` — `auto` (follow the agent's own capability), or force either side.
 *  - `frames_kept` — how many live frames stay in the agent's context (see `ImageBlock.frameKeep`).
 */
import { toolConfigService } from '../../domain/tools/tool-config.service';
import type { ToolConfigField, ToolContext } from '../types';

/** How many live screen frames stay in context when the operator's value is unusable. */
const DEFAULT_FRAMES_KEPT = 2;

/**
 * The two shared fields, spread into each screen tool's own `configSchema`. Kept as a factory so the
 * hints can name the tool's own vocabulary ("desktop" vs. "device") without duplicating the schema.
 */
export function screenAnalysisFields(surface: string): ToolConfigField[] {
  return [
    {
      key: 'screen_analysis',
      label: 'Screen analysis',
      type: 'select',
      options: ['auto', 'own_model', 'vision_endpoint'],
      default: 'auto',
      hint:
        `Who reads the ${surface} screenshot. \`auto\` (recommended): the agent's own model when it ` +
        `is multimodal, else the Vision endpoint. \`own_model\`: always hand the agent the frame — ` +
        `a text-only endpoint will choke on it. \`vision_endpoint\`: always route through Settings → ` +
        `Vision endpoint and return text, the pre-existing behaviour. Describe/read mode only; ` +
        `locating a target always uses the Vision endpoint.`,
    },
    {
      key: 'frames_kept',
      label: 'Screen frames kept in context',
      type: 'number',
      default: DEFAULT_FRAMES_KEPT,
      hint:
        `How many recent screenshots stay in a multimodal agent's context as pixels. Older frames are ` +
        `replaced by a one-line stub, so a long GUI session doesn't accumulate a full frame per tool ` +
        `call. 2 lets the agent compare before/after; 1 is the cheapest; 0 means keep every frame ` +
        `(unbounded — it will hit the context ceiling). Ignored when the Vision endpoint does the reading.`,
    },
  ];
}

export interface ScreenAnalysisPolicy {
  /** Feed the frame to the calling agent's own model instead of calling the Vision endpoint. */
  ownModel: boolean;
  /** `ImageBlock.frameKeep` to stamp on the frame; 0 = never evict. */
  framesKept: number;
}

/**
 * Resolve the effective policy for one describe-mode capture. Falls back to the Vision endpoint on
 * any config read failure — that is the behaviour every existing deployment already has.
 */
export async function resolveScreenAnalysis(
  toolName: string,
  schema: ToolConfigField[],
  ctx: ToolContext,
): Promise<ScreenAnalysisPolicy> {
  let mode = 'auto';
  let framesKept: number = DEFAULT_FRAMES_KEPT;
  try {
    const { config } = await toolConfigService.resolve(toolName, schema);
    mode = String(config.screen_analysis ?? 'auto');
    const n = Number(config.frames_kept);
    if (Number.isFinite(n) && n >= 0) framesKept = Math.trunc(n);
  } catch {
    /* keep the defaults */
  }
  const ownModel =
    mode === 'own_model' || (mode !== 'vision_endpoint' && ctx.supportsVision === true);
  return { ownModel, framesKept };
}

/**
 * The tool-result payload for a frame the agent reads itself. There is no `analysis` field on
 * purpose: the model must read the attached pixels rather than a paraphrase, and a text-only-shaped
 * key here is exactly what invites it to answer from the description it doesn't have.
 */
export function ownModelResult(
  base: Record<string, unknown>,
  surface: string,
): Record<string, unknown> {
  return {
    ...base,
    ok: true,
    read_by: 'agent',
    note: `The ${surface} screenshot is attached to this turn — read it yourself and answer from what you see.`,
  };
}
