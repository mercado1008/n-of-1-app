import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // ── Legacy app-shell tokens (nav, submissions UI) ──────────────────
        background: "var(--background)",
        foreground: "var(--foreground)",
        forest: "#535B50",
        gold:   "#C3AF88",
        sage:   "#A7B7A5",
        cloud:  "#E2E0D9",

        // ── Health Analysis document design tokens ─────────────────────────
        // Colours sampled from the N of 1 logo (assets/logo.png).
        // Do not substitute approximations — these are the literal logo pixel values.
        // Source: design_handoff_health_analysis/README.md "Design Tokens / Colours"

        brand: {
          olive:     "#535B50", // cover band, section rules, table headers, callout blocks
          oliveDark: "#2E332A", // section headings, finding gene names
          gold:      "#C6AF81", // section numerals, accent rules, list bullets, reference numerals
          goldDeep:  "#7A6A3E", // "fast/upregulated" status pills, "Monitor" severity
          goldPale:  "#F2EADA", // "fast/upregulated" pill background
        },

        ink: {
          body:       "#23261F", // body copy
          muted:      "#4A4E43", // secondary paragraph copy
          soft:       "#5C6155", // contributor / tertiary copy
          faint:      "#7A7F72", // rationale lines, italic notes
          label:      "#8A8F81", // uppercase eyebrow labels
          labelLight: "#9A9F91", // field labels inside cards, dose values
        },

        surface: {
          card:   "#F4F3EC", // pattern cards, strategy cards, exclusion callout
          notice: "#EFEDE4", // draft-notice band
          pill:   "#EDEDE4", // default status pill background
        },

        rule: {
          strong: "#DEDCD2", // metadata grid borders, header/footer rules
          medium: "#E4E2DA", // finding card dividers, table row borders
          light:  "#EDEBE3", // ingredient row dividers
        },

        paper: "#FFFFFF", // page background

        // Text colours for content rendered on the olive cover band
        onOlive: {
          DEFAULT: "#F4F3EE", // primary text on olive
          muted:   "#D6D8CE", // cover metadata line
          faint:   "#8E9686", // cover metadata separators (pipe glyphs)
          gold:    "#E4D6B4", // emphasis text inside olive callout
        },
      },

      fontFamily: {
        // App-shell UI (existing)
        sans: ["var(--font-geist-sans)", "Arial", "sans-serif"],

        // Health Analysis document typography
        // CSS variables injected by src/lib/fonts.ts via app/layout.tsx
        jost:  ["var(--font-jost)",  "Arial",          "sans-serif"],
        serif: ["var(--font-serif)", "Georgia",         "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
