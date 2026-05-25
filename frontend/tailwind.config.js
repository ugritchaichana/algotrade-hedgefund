/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // Use class-based dark mode toggle (data-theme attribute on <html>)
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // CSS variable driven — flip palette via data-theme="light" / "dark"
        background: 'rgb(var(--c-background) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        surfaceLight: 'rgb(var(--c-surfaceLight) / <alpha-value>)',
        primary: 'rgb(var(--c-primary) / <alpha-value>)',
        success: 'rgb(var(--c-success) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        text: 'rgb(var(--c-text) / <alpha-value>)',
        textMuted: 'rgb(var(--c-textMuted) / <alpha-value>)',
      }
    },
  },
  plugins: [],
}
