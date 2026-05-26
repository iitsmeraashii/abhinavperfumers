/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      keyframes: {
        'scan-line': {
          '0%':   { top: '12px',  opacity: '0.9' },
          '50%':  { opacity: '0.6' },
          '100%': { top: 'calc(100% - 12px)', opacity: '0.9' },
        },
      },
      animation: {
        'scan-line': 'scan-line 1.8s ease-in-out infinite alternate',
      },
      padding: {
        'safe-bottom': 'env(safe-area-inset-bottom)',
        'safe-top': 'env(safe-area-inset-top)',
        'safe-left': 'env(safe-area-inset-left)',
        'safe-right': 'env(safe-area-inset-right)',
      },
      height: {
        'bottom-nav': 'calc(3.75rem + env(safe-area-inset-bottom))',
      },
    },
  },
  plugins: [],
};
