/**
 * Deterministic per-agent color identity. The same agent name always maps to the same hue, so an
 * agent keeps one consistent color across bubbles, avatars, and nested sub-agent panels — this is
 * what lets a viewer tell at a glance "this work was done by db_agent, that by home_coordinator".
 *
 * An operator can override this on the Agents page by choosing an explicit hue + icon. The live
 * stream only knows agents by *name* (WS events carry no agent id), so chosen identities are held in
 * a small name-keyed registry populated from the agent list (`registerAgentIdentities`) and consulted
 * here as the source of truth, falling back to the name-hash color when an agent has no override.
 */
export interface AgentColor {
  /** Vivid accent (avatar, name, left rail). */
  accent: string;
  /** Panel border in the agent's hue. */
  border: string;
  /** Faint tinted background for the agent's bubble. */
  soft: string;
}

function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Name → operator-chosen identity (hue + icon key). Populated by `registerAgentIdentities`. */
const identityRegistry = new Map<string, { hue: number | null; icon: string }>();

/** Record the chosen identities for a set of agents so name-only lookups resolve overrides. */
export function registerAgentIdentities(
  agents: Array<{ name: string; color: number | null; icon: string }>,
): void {
  for (const a of agents) identityRegistry.set(a.name, { hue: a.color, icon: a.icon });
}

/** The registered icon key for an agent name, or `''` when unset/unknown. */
export function agentIcon(name: string): string {
  return identityRegistry.get(name)?.icon ?? '';
}

/**
 * The agent's color identity. Resolution order: an explicit `hue` argument, then the registered
 * override for this name, then the deterministic name-hash hue.
 */
export function agentColor(name: string, hue?: number | null): AgentColor {
  const chosen = hue ?? identityRegistry.get(name)?.hue ?? null;
  const h = chosen ?? hueFor(name || 'agent');
  // Only the *hue* belongs to the agent. Saturation, lightness and alpha come from the active theme
  // (`--identity-*`, see src/theme/themes/*.css): an identity tuned to read on the deep-space ground
  // is invisible ink on Paper's cream. The variables resolve at paint, so these stay valid inline
  // `style` values and re-resolve by themselves when the theme changes.
  return {
    accent: `hsl(${h} var(--identity-accent-s) var(--identity-accent-l))`,
    border: `hsl(${h} var(--identity-border-s) var(--identity-border-l) / var(--identity-border-a))`,
    soft: `hsl(${h} var(--identity-soft-s) var(--identity-soft-l) / var(--identity-soft-a))`,
  };
}

/**
 * The agent's hue at an arbitrary alpha, for the `--glow` variable behind `animate-glow-pulse`.
 *
 * Call sites used to build this by concatenating a two-digit hex alpha onto `accent` — which was
 * never valid CSS for an `hsl()` string, so those glows silently fell back to the keyframe's
 * default blue. Ask for the alpha instead.
 */
export function agentGlow(name: string, alpha = 0.2, hue?: number | null): string {
  const chosen = hue ?? identityRegistry.get(name)?.hue ?? null;
  const h = chosen ?? hueFor(name || 'agent');
  return `hsl(${h} var(--identity-accent-s) var(--identity-accent-l) / ${alpha})`;
}

/** First letter for a compact avatar chip. */
export function agentInitial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
