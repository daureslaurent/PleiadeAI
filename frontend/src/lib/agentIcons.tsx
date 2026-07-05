import {
  Bot,
  Brain,
  Cpu,
  Database,
  Terminal,
  Globe,
  Shield,
  Search,
  Code,
  Cog,
  Zap,
  Sparkles,
  Rocket,
  Compass,
  BookOpen,
  Feather,
  Flame,
  Leaf,
  Wrench,
  Network,
  Server,
  Cloud,
  Bug,
  Key,
  Eye,
  MessageCircle,
  PenTool,
  BarChart3,
  Map,
  Hammer,
  Wand2,
  Ghost,
  Atom,
  Gauge,
  type LucideIcon,
} from 'lucide-react';

/**
 * Curated lucide subset an operator (or the LLM suggester) can assign as an agent's logo. Keys are
 * kebab-case and MUST stay in sync with the backend's `identity.constants.ts` `ICON_KEYS`, so a
 * suggested icon always resolves to a component here. `''` (unset) → fall back to the initial letter.
 */
export const AGENT_ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  brain: Brain,
  cpu: Cpu,
  database: Database,
  terminal: Terminal,
  globe: Globe,
  shield: Shield,
  search: Search,
  code: Code,
  cog: Cog,
  zap: Zap,
  sparkles: Sparkles,
  rocket: Rocket,
  compass: Compass,
  'book-open': BookOpen,
  feather: Feather,
  flame: Flame,
  leaf: Leaf,
  wrench: Wrench,
  network: Network,
  server: Server,
  cloud: Cloud,
  bug: Bug,
  key: Key,
  eye: Eye,
  'message-circle': MessageCircle,
  'pen-tool': PenTool,
  'bar-chart-3': BarChart3,
  map: Map,
  hammer: Hammer,
  'wand-2': Wand2,
  ghost: Ghost,
  atom: Atom,
  gauge: Gauge,
};

/** Ordered keys for the picker grid. */
export const ICON_KEYS = Object.keys(AGENT_ICONS);

/** Preset swatch hues — mirrors the backend `PRESET_HUES`. */
export const PRESET_HUES = [0, 25, 45, 90, 140, 165, 190, 210, 235, 265, 290, 320];

/** Resolve an icon key to its component, or `null` when unset/unknown (caller shows the initial). */
export function iconFor(key: string | null | undefined): LucideIcon | null {
  if (!key) return null;
  return AGENT_ICONS[key] ?? null;
}
