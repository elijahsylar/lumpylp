import type { Config } from 'tailwindcss';

// Colors are CSS variables — see :root and [data-theme="..."] blocks in
// src/index.css for the per-theme values. The `<alpha-value>` placeholder
// is filled by Tailwind so opacity utilities (text-accent/50 etc.) work.
const themed = (name: string) => `rgb(var(--color-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: themed('bg'),
        accent: {
          DEFAULT: themed('accent'),
          dim: themed('accent-dim'),
          bright: themed('accent-bright'),
        },
        border: themed('border'),
        body: {
          DEFAULT: themed('body'),
          dim: themed('body-dim'),
          'very-dim': themed('body-very-dim'),
        },
        // `text-white` and `bg-white` track the strongest foreground in the
        // active theme. On Light theme this is black; on dark themes it's
        // white. Existing usages of text-white work without a sweep.
        white: themed('fg-strong'),
        // The Tailwind default red-500 (#ef4444) fails AA on Light theme bg.
        // Override the whole red-500 token so error/dumped/down-vote markers
        // stay readable in every theme without changing classNames.
        red: {
          500: themed('error'),
        },
      },
      // Notch / home-indicator insets. Resolve to 0 on hardware without
      // them, and on any browser that ignores viewport-fit=cover, so these
      // are safe to apply unconditionally.
      spacing: {
        'safe-t': 'env(safe-area-inset-top)',
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-l': 'env(safe-area-inset-left)',
        'safe-r': 'env(safe-area-inset-right)',
      },
      fontFamily: {
        // Both tokens are theme-driven — see :root and [data-theme="..."]
        // blocks in src/index.css. Existing className="font-mono" /
        // className="font-display" usages auto-update per active theme.
        mono: ['var(--font-body)', 'monospace'],
        display: ['var(--font-display)', 'monospace'],
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
