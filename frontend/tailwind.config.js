/** @type {import('tailwindcss').Config} */
/*
 * Design system mirrored from andhbhakt.org:
 *   font   — Space Grotesk (sans) + IBM Plex Mono (numerals/code)
 *   primary— hsl(25 95% 53%)  orange
 *   accent — hsl(215 85% 60%) blue
 *   chrome — slate (hue 215) darks for sidebar / nav / headers
 *   radius — 0.375rem, tracking -0.01em
 * The legacy `brand` / `field` / `cream` / `amber` scale names are kept so the
 * existing markup keeps working; only their values are re-pointed.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Primary — orange, hsl(25 95% 53%)
        brand: {
          50:  '#fff7ed',
          100: '#ffedd5',
          300: '#fdba74',
          400: '#f97316',
          500: '#ea580c',
          600: '#c2410c',
          700: '#9a3412',
        },
        // Dark chrome — sidebar, bottom nav, page headers
        field: {
          950: '#0f172a',
          900: '#16202f',
          800: '#1e293b',
          700: '#334155',
        },
        // Card / surface — white like the reference content area
        cream: {
          DEFAULT: '#ffffff',
          50:  '#ffffff',
          100: '#ffffff',
          200: '#f1f5f9',
        },
        // Neutral borders + soft surfaces (re-pointed from the amber scale)
        amber: {
          50:  '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
        },
        // App canvas behind the cards
        canvas: '#f8fafc',
        // Secondary accent — hsl(215 85% 60%)
        accent: {
          400: '#5c9ceb',
          500: '#3b82f6',
          600: '#2563eb',
        },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"Courier New"', 'monospace'],
      },
      fontWeight: {
        // Space Grotesk tops out at 700 — avoid synthetic-bold smearing
        black: '700',
        extrabold: '700',
      },
      letterSpacing: {
        normal: '-0.01em',
      },
      borderRadius: {
        DEFAULT: '0.375rem',
      },
      boxShadow: {
        sm: '0px 1px 2px 0px #0000000f, 0px 1px 3px 0px #0000001a',
        DEFAULT: '0px 2px 4px -1px #0000000f, 0px 4px 6px -1px #0000001a',
        md: '0px 4px 6px -2px #0000000d, 0px 10px 15px -3px #0000001a',
        lg: '0px 10px 15px -3px #0000001a, 0px 20px 25px -5px #0000001a',
        xl: '0px 20px 25px -5px #0000001a, 0px 25px 50px -12px #00000040',
        '2xl': '0px 25px 50px -12px #00000040',
      },
    },
  },
  plugins: [],
}
