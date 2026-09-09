import type { Config } from 'tailwindcss';

/**
 * High-density, wide-layout UI for clear data parsing (spec §1).
 *
 * Every colour, radius and font family below resolves to a **CSS custom property** rather than a
 * literal, so the ~2500 colour classes already written across the app are themeable without being
 * touched (THEME_SYSTEM_PLAN.md §1.1). The values live in `src/theme/themes/*.css`, one
 * `:root[data-theme="…"]` block per theme; `src/theme/apply.ts` stamps the attribute.
 *
 * Two conventions matter when reading a class name in a component:
 *
 * - The neutral ramp is a **foreground ramp**: `slate-100` is the strongest text, `400`/`500`
 *   secondary, `600` faintest. A light theme is therefore not a mirror of the dark one — it
 *   authors its own eleven stops so the mid-greys stay mid-grey.
 * - `white` means *the raise colour* and `black` *the well colour* — what a translucent overlay
 *   lightens or darkens a surface with. On a light theme both are ink, not paper. The four idioms
 *   that carry the app's structure (`.hairline`, `.raise-*`, `.well*`) are utilities in index.css
 *   instead, because a 6% hairline that reads on dark is invisible on cream and an alpha baked
 *   into a class name cannot vary per theme.
 */

/** One themed colour ramp: every Tailwind stop pointed at `--c-<name>-<stop>`. */
const ramp = (name: string) =>
  Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((stop) => [
      stop,
      `rgb(var(--c-${name}-${stop}) / <alpha-value>)`,
    ]),
  );

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral foreground ramp — the app's text scale.
        slate: ramp('slate'),
        // Semantic state ramps. Themed too, so Terminal can make "ok" phosphor-green and Paper can
        // darken every state colour enough to read on cream.
        emerald: ramp('emerald'),
        amber: ramp('amber'),
        red: ramp('red'),
        sky: ramp('sky'),
        rose: ramp('rose'),
        indigo: ramp('indigo'),
        // Contrast alphas (see the header note).
        white: 'rgb(var(--c-raise) / <alpha-value>)',
        black: 'rgb(var(--c-well) / <alpha-value>)',
        // Ink on a *filled* surface — text on the accent button, the toggle knob, a label on a
        // photo. It sits on a colour rather than on the ground, so it does not follow the ramp.
        oncolor: 'rgb(var(--c-on-color) / <alpha-value>)',
        // Scrims over media (video letterbox, a badge on a thumbnail). Dark in every theme,
        // because what it darkens is a picture, not a panel.
        scrim: 'rgb(var(--c-scrim) / <alpha-value>)',
        // Named surfaces and the two identity hues.
        panel: 'rgb(var(--c-panel) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        border: 'rgb(var(--c-border) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        reasoning: 'rgb(var(--c-reasoning) / <alpha-value>)',
      },
      // The whole scale, not a subset: a theme that squares its corners (Terminal) has to square
      // `rounded` and `rounded-sm` too, or the odd chip stays curved. `rounded-full` is deliberately
      // left alone — a pill is a shape, not a radius.
      borderRadius: {
        DEFAULT: 'var(--r-sm)',
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        '2xl': 'var(--r-2xl)',
        '3xl': 'var(--r-3xl)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        serif: ['var(--font-serif)', 'ui-serif', 'Georgia', 'serif'],
        // Long-form prose (markdown bodies). Usually the same face as the UI; Paper points it at a
        // serif, which is the one thing that theme exists to do.
        prose: ['var(--font-prose)', 'var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        // Message entrance: rise + fade, slightly overdamped so it feels physical.
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px) scale(0.99)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        // Left-to-right sheen across text (thinking label) or surfaces.
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
        // Soft breathing glow for live/active elements (colour via --glow). `--glow-strength`
        // scales the spread, so a flat theme can switch the whole vocabulary off from its CSS.
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 var(--glow, rgb(var(--c-accent) / 0.35))' },
          '50%': {
            boxShadow:
              '0 0 calc(18px * var(--glow-strength, 1)) calc(2px * var(--glow-strength, 1)) var(--glow, rgb(var(--c-accent) / 0.35))',
          },
        },
        // Slow drift for animated gradient fills (user bubble, send button).
        'gradient-x': {
          '0%, 100%': { backgroundPosition: '0% 50%' },
          '50%': { backgroundPosition: '100% 50%' },
        },
        // Streaming caret.
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        // Starfield twinkle (applied to the star layers in index.css). Scaled by `--stars-opacity`
        // so a theme with no starfield fades to nothing rather than pulsing invisibly.
        twinkle: {
          '0%, 100%': { opacity: 'calc(0.7 * var(--stars-opacity, 1))' },
          '50%': { opacity: 'calc(0.25 * var(--stars-opacity, 1))' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.21, 1.02, 0.73, 1) both',
        shimmer: 'shimmer 2.2s linear infinite',
        'glow-pulse': 'glow-pulse 2.4s ease-in-out infinite',
        'gradient-x': 'gradient-x 6s ease infinite',
        blink: 'blink 1s step-end infinite',
        twinkle: 'twinkle 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
} satisfies Config;
