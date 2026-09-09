/**
 * Shared policy for the GUI-control tools' screen reading (`visual_*`, `android_*`).
 *
 * These tools were designed around a **text-only orchestrator**: every capture was routed through
 * the operator-configured **Vision endpoint**, which handed the calling agent a second-hand *prose
 * description* of its own screen. That is the right shape for a text-only agent, and strictly lossy
 * for a multimodal one: the runner already feeds tool-returned images to a vision-capable agent as
 * raw pixels (see `AgentRunner`'s `supportsVision` gate), and `analyze_image` is withheld from such
 * agents for exactly this reason — a weaker second model paraphrasing what the agent could read
 * itself.
 *
 * So there are now two modes, chosen globally in Settings → Vision (`screen_control_mode`, see
 * `VISUAL_MODAL_PLAN.md`):
 *
 *  - **`legacy`** — the pre-existing behaviour: the Vision endpoint reads and locates, the agent
 *    works from text it never verified.
 *  - **`modal`** — the agent's own multimodal model *is* the vision model. Frames arrive as pixels;
 *    the agent points at what it sees and the tools execute. No second model, no coordinate-fraction
 *    prompt, no calibration.
 *  - **`auto`** (default) — `modal` for a vision-capable caller, `legacy` otherwise, so a fleet
 *    mixing text-only and multimodal agents needs no per-agent config.
 *
 * The mode is global rather than per-tool because it is one concept, not four: whether a screen is
 * read by the agent or by a proxy. The only per-tool knob left here is `frames_kept`, which is a
 * context budget, not a mode.
 */
import { settingsService } from '../../domain/settings/settings.service';
import { toolConfigService } from '../../domain/tools/tool-config.service';
import type { ToolConfigField, ToolContext } from '../types';

/** How many live screen frames stay in context when the operator's value is unusable. */
const DEFAULT_FRAMES_KEPT = 2;

/**
 * The shared per-tool field, spread into each screen tool's own `configSchema`. Kept as a factory so
 * the hint can name the tool's own vocabulary ("desktop" vs. "device") without duplicating the
 * schema. The mode itself lives in Settings — see the module docblock.
 */
export function screenAnalysisFields(surface: string): ToolConfigField[] {
  return [
    {
      key: 'frames_kept',
      label: 'Screen frames kept in context',
      type: 'number',
      default: DEFAULT_FRAMES_KEPT,
      hint:
        `How many recent ${surface} screenshots stay in a multimodal agent's context as pixels. Older ` +
        `frames are replaced by a one-line stub, so a long GUI session doesn't accumulate a full frame ` +
        `per tool call. 2 lets the agent compare before/after; 1 is the cheapest; 0 means keep every ` +
        `frame (unbounded — it will hit the context ceiling). Ignored in legacy mode, where the Vision ` +
        `endpoint does the reading (Settings → Vision → Screen control).`,
    },
  ];
}

/**
 * Resolve the effective screen-control mode for one caller: the global setting, with `auto` falling
 * back to whether the calling agent's own model can accept an image. Defaults to `legacy` if the
 * settings read fails — that is the behaviour every deployment already had.
 */
export async function resolveScreenControlMode(caller: {
  /** Whether the calling agent's own model accepts images (`ToolContext.supportsVision`). */
  supportsVision?: boolean;
}): Promise<'modal' | 'legacy'> {
  try {
    const { screen_control_mode: mode } = await settingsService.get();
    if (mode === 'modal') return 'modal';
    if (mode === 'legacy') return 'legacy';
    return caller.supportsVision === true ? 'modal' : 'legacy';
  } catch {
    return 'legacy';
  }
}

export interface ScreenAnalysisPolicy {
  /** Feed the frame to the calling agent's own model instead of calling the Vision endpoint. */
  ownModel: boolean;
  /** `ImageBlock.frameKeep` to stamp on the frame; 0 = never evict. */
  framesKept: number;
}

/** Resolve the mode *and* this tool's frame budget for one capture. */
export async function resolveScreenAnalysis(
  toolName: string,
  schema: ToolConfigField[],
  ctx: ToolContext,
): Promise<ScreenAnalysisPolicy> {
  let framesKept: number = DEFAULT_FRAMES_KEPT;
  try {
    const { config } = await toolConfigService.resolve(toolName, schema);
    const n = Number(config.frames_kept);
    if (Number.isFinite(n) && n >= 0) framesKept = Math.trunc(n);
  } catch {
    /* keep the default */
  }
  return { ownModel: (await resolveScreenControlMode(ctx)) === 'modal', framesKept };
}

/**
 * The tool-result payload for a frame the agent reads itself. There is no `analysis` field on
 * purpose: the model must read the attached pixels rather than a paraphrase, and a text-only-shaped
 * key here is exactly what invites it to answer from the description it doesn't have. `note` carries
 * whatever the caller must know about *this* frame (a plain read, or a grid it can measure against).
 */
export function ownModelResult(
  base: Record<string, unknown>,
  surface: string,
  note?: string,
): Record<string, unknown> {
  return {
    ...base,
    ok: true,
    read_by: 'agent',
    note:
      note ??
      `The ${surface} screenshot is attached to this turn — read it yourself and answer from what you see.`,
  };
}
