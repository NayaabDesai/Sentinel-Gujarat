/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#090d16",
          900: "#0e1420",
          800: "#151c2c",
          700: "#1c2538",
        },
        saffron: {
          400: "#fbbf24",
          500: "#f59e0b",
          600: "#d97706",
        },
        forest: {
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
        },
        rose: {
          400: "#fb7185",
          500: "#f43f5e",
        },
        chalk: "#e8eef7",
      },
      fontFamily: {
        display: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        panel: "0 12px 40px rgba(0, 0, 0, 0.45)",
      },
      keyframes: {
        radar: {
          "0%": { transform: "scale(0.4)", opacity: "0.7" },
          "100%": { transform: "scale(1.6)", opacity: "0" },
        },
      },
      animation: {
        radar: "radar 1.6s ease-out infinite",
      },
    },
  },
  plugins: [],
};
