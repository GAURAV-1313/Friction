/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        surface: '#0b0b0b',
        card: '#121212',
        border: '#222222',
        muted: '#9aa0a6',
        accent: '#4f8cff',
        insight: '#1f9d55',
        confusion: '#f59f00'
      },
      boxShadow: {
        soft: '0 6px 24px rgba(0, 0, 0, 0.35)'
      }
    }
  },
  plugins: [require('@tailwindcss/forms')]
};
