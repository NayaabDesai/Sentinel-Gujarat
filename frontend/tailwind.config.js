/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0b1220",
          900: "#111b2e",
          800: "#1a2740",
          700: "#243552",
        },
        saffron: {
          400: "#f0a04b",
          500: "#e8872a",
          600: "#c96a14",
        },
        forest: {
          400: "#3d9a6a",
          500: "#2d7a52",
          600: "#1f5c3c",
        },
        chalk: "#e8eef7",
      },
      fontFamily: {
        display: ['"Source Serif 4"', "Georgia", "serif"],
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        panel: "0 12px 40px rgba(8, 16, 32, 0.35)",
      },
    },
  },
  plugins: [],
};
