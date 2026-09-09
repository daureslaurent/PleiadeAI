/**
 * The theme registry (THEME_SYSTEM_PLAN.md §2.1).
 *
 * A theme is a palette + a surface treatment + a type choice, applied to the *whole* app. Its
 * values live in `themes/<id>.css` as one `:root[data-theme="<id>"]` block; this file holds only
 * what JavaScript needs — the label the picker shows, and the handful of third-party libraries
 * (Monaco, Mermaid, Prism) that carry their own theme and cannot read a CSS variable.
 *
 * Adding a theme is: one CSS file, one entry here. Nothing else in the app changes.
 */

export type ThemeId = 'pleiades' | 'codex' | 'terminal' | 'paper' | 'nebula';

export interface ThemeDef {
  id: ThemeId;
  label: string;
  /** One line on the picker card — what this theme is *for*. */
  blurb: string;
  /**
   * Light or dark. Drives `<html class="dark">` (so Tailwind's `dark:` variant and any library
   * keyed off it agree with us), the Prism code-block theme, and Monaco's base.
   */
  mode: 'dark' | 'light';
  /** Browser chrome colour on mobile / PWA. */
  themeColor: string;
  /** Ground, raised surface, accent — painted literally on the picker card. */
  swatch: [string, string, string];
  /** Mermaid's own theming, which takes concrete colours rather than CSS variables. */
  mermaid: {
    theme: 'dark' | 'base';
    background: string;
    primaryColor: string;
    primaryTextColor: string;
    primaryBorderColor: string;
    lineColor: string;
    secondaryColor: string;
    tertiaryColor: string;
  };
  /** Monaco token colours, hex without `#` (see lib/monacoTheme.ts). */
  monaco: {
    base: 'vs' | 'vs-dark';
    fg: string;
    comment: string;
    keyword: string;
    control: string;
    string: string;
    number: string;
    type: string;
    punctuation: string;
    selection: string;
    lineHighlight: string;
  };
}

export const DEFAULT_THEME: ThemeId = 'pleiades';

export const THEMES: ThemeDef[] = [
  {
    id: 'pleiades',
    label: 'Pleiades',
    blurb: 'Frosted glass over a deep-space starfield. The command center as an observatory.',
    mode: 'dark',
    themeColor: '#0f1419',
    swatch: ['#0b0f16', '#161b22', '#3b82f6'],
    mermaid: {
      theme: 'dark',
      background: '#0f1419',
      primaryColor: '#161b22',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#3b82f6',
      lineColor: '#475569',
      secondaryColor: '#1e293b',
      tertiaryColor: '#0f1419',
    },
    monaco: {
      base: 'vs-dark',
      fg: 'e2e8f0',
      comment: '64748b',
      keyword: '60a5fa',
      control: 'c084fc',
      string: '34d399',
      number: 'fbbf24',
      type: '7dd3fc',
      punctuation: '94a3b8',
      selection: '3b82f640',
      lineHighlight: 'ffffff08',
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    blurb: 'Flat, light and neutral. Opaque cards, one hairline rule, no glow — a document tool.',
    mode: 'light',
    themeColor: '#ffffff',
    swatch: ['#f7f7f8', '#ffffff', '#10a37f'],
    mermaid: {
      theme: 'base',
      background: '#ffffff',
      primaryColor: '#f7f7f8',
      primaryTextColor: '#18181b',
      primaryBorderColor: '#10a37f',
      lineColor: '#8e8e97',
      secondaryColor: '#ececf1',
      tertiaryColor: '#ffffff',
    },
    monaco: {
      base: 'vs',
      fg: '27272a',
      comment: '8e8e97',
      keyword: '0f766e',
      control: '7c3aed',
      string: '15803d',
      number: 'b45309',
      type: '0369a1',
      punctuation: '52525b',
      selection: '10a37f33',
      lineHighlight: '00000008',
    },
  },
  {
    id: 'terminal',
    label: 'Terminal',
    blurb: 'The fleet as a TTY. One monospace family, square corners, phosphor green.',
    mode: 'dark',
    themeColor: '#07090b',
    swatch: ['#07090b', '#0d1117', '#7ee787'],
    mermaid: {
      theme: 'dark',
      background: '#07090b',
      primaryColor: '#0d1117',
      primaryTextColor: '#e6edf3',
      primaryBorderColor: '#7ee787',
      lineColor: '#545d68',
      secondaryColor: '#161b22',
      tertiaryColor: '#07090b',
    },
    monaco: {
      base: 'vs-dark',
      fg: 'e6edf3',
      comment: '6e7681',
      keyword: '7ee787',
      control: 'd29922',
      string: '79c0ff',
      number: 'ffa657',
      type: 'a5d6ff',
      punctuation: '8b949e',
      selection: '7ee78730',
      lineHighlight: 'ffffff06',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    blurb: 'Warm cream, ink-dark text, serif prose. Built for reading a long answer.',
    mode: 'light',
    themeColor: '#faf7f2',
    swatch: ['#faf7f2', '#fffdf9', '#8a5a2b'],
    mermaid: {
      theme: 'base',
      background: '#faf7f2',
      primaryColor: '#fffdf9',
      primaryTextColor: '#292524',
      primaryBorderColor: '#8a5a2b',
      lineColor: '#a8a094',
      secondaryColor: '#f0e9dd',
      tertiaryColor: '#faf7f2',
    },
    monaco: {
      base: 'vs',
      fg: '3d3733',
      comment: 'a8a094',
      keyword: '8a5a2b',
      control: '6b4f8a',
      string: '3f6212',
      number: 'b45309',
      type: '155e75',
      punctuation: '78716c',
      selection: '8a5a2b26',
      lineHighlight: '0000000a',
    },
  },
  {
    id: 'nebula',
    label: 'Nebula',
    blurb: 'Deep space, saturated. Violet ground, cyan and magenta, glow turned up.',
    mode: 'dark',
    themeColor: '#0e0a1c',
    swatch: ['#0d0722', '#181229', '#22d3ee'],
    mermaid: {
      theme: 'dark',
      background: '#0e0a1c',
      primaryColor: '#18122d',
      primaryTextColor: '#e2e8f0',
      primaryBorderColor: '#22d3ee',
      lineColor: '#6d5f9c',
      secondaryColor: '#241a45',
      tertiaryColor: '#0e0a1c',
    },
    monaco: {
      base: 'vs-dark',
      fg: 'e9e6ff',
      comment: '7a6ca8',
      keyword: '22d3ee',
      control: 'e879f9',
      string: '5eead4',
      number: 'fcd34d',
      type: 'a5f3fc',
      punctuation: 'a78bfa',
      selection: '22d3ee33',
      lineHighlight: 'ffffff0a',
    },
  },
];

export const THEME_IDS = THEMES.map((t) => t.id);

export function themeById(id: string | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;
}

export const isThemeId = (v: unknown): v is ThemeId =>
  typeof v === 'string' && (THEME_IDS as string[]).includes(v);
