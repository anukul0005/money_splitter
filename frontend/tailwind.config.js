/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f0fdf4',
          100: '#dcfce7',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
        },
        field: {
          950: '#0d2416',
          900: '#152d1e',
          800: '#1d4230',
          700: '#255040',
        },
        cream: {
          DEFAULT: '#faf8ef',
          50:  '#fffef9',
          100: '#faf8ef',
          200: '#f0e9d5',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
