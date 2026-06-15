/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0e0f13',
          panel: '#16181d',
          elevated: '#1c1f26',
          hover: '#23262e',
          input: '#1a1d24'
        },
        line: '#2a2e37',
        accent: {
          DEFAULT: '#6d8cff',
          hover: '#8aa1ff',
          dim: '#26304f'
        },
        ink: {
          DEFAULT: '#e6e8ee',
          soft: '#9aa1ad',
          faint: '#646b78'
        },
        ok: '#46c08a',
        warn: '#e0b341',
        bad: '#e0625e'
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Mono', 'JetBrains Mono', 'Consolas', 'monospace']
      },
      borderRadius: {
        xl: '12px'
      }
    }
  },
  plugins: []
}
