import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#0a0c10",
        foreground: "#e2e8f0",
        panel: "#111318",
        elevated: "#181b22",
        border: "#1e2330",
        muted: "#7d8a9a",
        "muted-deep": "#404858",
        accent: "#22c55e",
        critical: "#ef4444",
        warning: "#f97316",
        caution: "#eab308",
        active: "#3b82f6",
        mono: "#94a3b8"
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
