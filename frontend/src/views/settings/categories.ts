import {
  Brain,
  KeyRound,
  MonitorCog,
  RefreshCcwDot,
  Server,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The six settings categories — the cards on `/settings`, one page each at `/settings/<slug>`.
 *
 * Grouped by *what the operator is tuning*, not by which collection backs it: everything about
 * talking to a model server is Inference; everything the whole fleet inherits is Fleet; anything
 * that hands out access to this instance or destroys its data is Access & Data.
 */
export interface SettingsCategory {
  slug: string;
  title: string;
  /** One line on the card — what you come here to change. */
  blurb: string;
  /** The sections this page contains, listed on the card so the operator can scan for a setting. */
  contains: string[];
  icon: LucideIcon;
  /** `danger` tints the icon tile red — this card holds irreversible actions. */
  tone?: 'accent' | 'danger';
}

export const CATEGORIES: SettingsCategory[] = [
  {
    slug: 'inference',
    title: 'Inference',
    blurb: 'Where models run and how they sample.',
    contains: ['Endpoints', 'Generation', 'Vision', 'Image generation'],
    icon: Server,
  },
  {
    slug: 'memory',
    title: 'Memory',
    blurb: 'The embeddings server behind the vault, and what agents keep from a turn.',
    contains: ['Embeddings', 'Long-term memory'],
    icon: Brain,
  },
  {
    slug: 'fleet',
    title: 'Fleet',
    blurb: 'Standing rules and services every agent inherits.',
    contains: ['House rules (AGENTS.md)', 'Quality scorer', 'Fine-tune servers'],
    icon: Users,
  },
  {
    slug: 'interface',
    title: 'Interface',
    blurb: 'Display preferences, saved on this device.',
    contains: ['Debugger & chat display'],
    icon: MonitorCog,
  },
  {
    slug: 'system',
    title: 'System & Updates',
    blurb: 'Pull the latest master and rebuild the stack.',
    contains: ['Update checks', 'Deployed version'],
    icon: RefreshCcwDot,
  },
  {
    slug: 'access',
    title: 'Access & Data',
    blurb: 'Who may call this instance — and how to back it up or wipe it.',
    contains: ['API keys', 'Backup & transfer', 'Danger zone'],
    icon: KeyRound,
    tone: 'danger',
  },
];

export const categoryBySlug = (slug: string | undefined) => CATEGORIES.find((c) => c.slug === slug);
