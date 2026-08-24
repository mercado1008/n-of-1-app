/**
 * scripts/generate-docs/health-analysis-pdf.ts
 *
 * Renders the Health Analysis HTML string to a PDF Buffer using Puppeteer.
 *
 * Uses A4 format, printBackground: true (required for olive cover band,
 * table headers, card fills). Fonts loaded from Google Fonts CDN via
 * waitUntil: 'networkidle2' so Jost + Source Serif 4 are embedded correctly.
 *
 * Browser is launched fresh per call and closed after. This is acceptable for
 * batch generation; for a server route, share a browser instance instead.
 */

import puppeteer from 'puppeteer';

export interface GenerateHealthAnalysisPdfOptions {
  html: string;
}

export async function generateHealthAnalysisPdf(
  opts: GenerateHealthAnalysisPdfOptions,
): Promise<Buffer> {
  const { html } = opts;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();

    // Set content and wait for Google Fonts to load (networkidle2 = ≤2 open
    // network connections for 500ms; sufficient for font CDN loads).
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    // Wait for Google Fonts to finish loading before capturing PDF
    await page.evaluateHandle(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      // No displayHeaderFooter — running headers/footers are implemented as
      // position:fixed elements in the HTML for v1. Add Puppeteer
      // headerTemplate/footerTemplate in v2 if per-page page-number headers
      // are required.
    });

    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
