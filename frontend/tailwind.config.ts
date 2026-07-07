import type { Config } from 'tailwindcss';

// High-density, wide-layout dark mode for clear data parsing (spec §1).
// The workspace wears a "deep space" glass theme: translucent panels (glass utilities in
// index.css) floating over a starfield gradient, with the motion vocabulary defined here.
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        panel: '#0f1419',
        surface: '#161b22',
        border: '#2a3038',
        accent: '#3b82f6',
        reasoning: '#a855f7',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
        // Soft breathing glow for live/active elements (color via --glow).
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 0 var(--glow, rgba(59,130,246,0.35))' },
          '50%': { boxShadow: '0 0 18px 2px var(--glow, rgba(59,130,246,0.35))' },
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
        // Starfield twinkle (applied to the star layers in index.css).
        twinkle: {
          '0%, 100%': { opacity: '0.7' },
          '50%': { opacity: '0.25' },
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
