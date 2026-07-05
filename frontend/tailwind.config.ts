import type { Config } from 'tailwindcss';

// High-density, wide-layout dark mode for clear data parsing (spec §1).
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
    },
  },
  plugins: [],
} satisfies Config;
