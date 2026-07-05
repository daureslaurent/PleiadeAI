/**
 * Canonical palette + icon set for an agent's visual identity (spec: Agents page color/logo pick).
 *
 * The frontend mirrors these exact values in `lib/agentIcons.tsx` / `lib/agentColor.ts` — this copy
 * is the *authoritative* list the LLM identity suggester is constrained to, so a suggestion always
 * maps to a swatch the operator sees and an icon the frontend can render.
 */

/**
 * Preset swatch hues (HSL, 0–360). Chosen roughly evenly around the wheel and tuned to read well on
 * the dark surface once run through `agentColor()`'s fixed saturation/lightness. Stored on the agent
 * as a plain hue number; `null` means "unset" → fall back to the deterministic name-hash color.
 */
export const PRESET_HUES = [0, 25, 45, 90, 140, 165, 190, 210, 235, 265, 290, 320] as const;

/**
 * Curated lucide icon keys (kebab-case). The frontend maps each to a `lucide-react` component; an
 * empty string means "unset" → fall back to the agent's initial letter in the avatar chip.
 */
export const ICON_KEYS = [
  'bot',
  'brain',
  'cpu',
  'database',
  'terminal',
  'globe',
  'shield',
  'search',
  'code',
  'cog',
  'zap',
  'sparkles',
  'rocket',
  'compass',
  'book-open',
  'feather',
  'flame',
  'leaf',
  'wrench',
  'network',
  'server',
  'cloud',
  'bug',
  'key',
  'eye',
  'message-circle',
  'pen-tool',
  'bar-chart-3',
  'map',
  'hammer',
  'wand-2',
  'ghost',
  'atom',
  'gauge',
] as const;

export type IconKey = (typeof ICON_KEYS)[number];

/** Nearest preset hue to an arbitrary number (keeps a stray LLM value on-palette). */
export function nearestPresetHue(hue: number): number {
  const h = ((Math.round(hue) % 360) + 360) % 360;
  let best: number = PRESET_HUES[0];
  let bestDist = 360;
  for (const p of PRESET_HUES) {
    const d = Math.min(Math.abs(p - h), 360 - Math.abs(p - h));
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/** True when a string is one of the curated icon keys. */
export function isIconKey(value: unknown): value is IconKey {
  return typeof value === 'string' && (ICON_KEYS as readonly string[]).includes(value);
}
