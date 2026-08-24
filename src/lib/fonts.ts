/**
 * src/lib/fonts.ts
 *
 * Brand typography for N of 1 Health Analysis documents.
 * Loaded via next/font/google so Next.js self-hosts the woff2 files at build
 * time — no network fetch during Puppeteer PDF generation.
 *
 * Usage: import { jost, sourceSerif } from '@/lib/fonts';
 * Then spread `.variable` into the root <html> or <body> className so the CSS
 * custom properties (--font-jost, --font-serif) are available everywhere.
 *
 * Families per design spec (README "Typography"):
 *   Jost           — all UI furniture: headings, labels, eyebrows, data values,
 *                    pills, table headers, numerals
 *   Source Serif 4 — all running body copy, interpretations, rationales,
 *                    references
 */
import { Jost, Source_Serif_4 } from 'next/font/google';

export const jost = Jost({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-jost',
  display: 'swap',
});

export const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
});
