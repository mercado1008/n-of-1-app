/**
 * GET /api/reports/[submissionId]/pdf
 *
 * Puppeteer PDF route — renders the branded Health Analysis document to a
 * downloadable PDF without requiring any browser print dialog interaction.
 *
 * Strategy: "navigate to self" — Puppeteer navigates to the review page and
 * calls page.pdf(). The browser-print CSS path (globals.css @media print)
 * handles all layout:
 *
 *   - @page { margin-top:1in; margin-bottom:1in } reserves space on every page
 *     for the running header and footer.
 *   - CSS position:fixed doc-header-wrap / doc-footer-wrap fill those margins.
 *   - print-color-adjust: exact ensures all backgrounds/fills render.
 *
 * Why physical margin = 0:
 *   Puppeteer's `margin` option adds a PHYSICAL PDF margin on top of Chrome's
 *   CSS @page margin — they stack, not replace. If both are 1in, Chrome paginates
 *   content for 246mm-tall pages (297mm − 2 × 25.4mm CSS margins) but then
 *   Puppeteer tries to fit that into a further-reduced physical content area,
 *   triggering an ~83% scale-down and narrow content.  Setting margin = 0 lets
 *   the CSS @page margin be the sole margin driver, matching the browser-print
 *   path exactly: full A4 width, correct page height, no scale artefacts.
 *
 * Filename convention (matches existing .docx/.xlsx naming):
 *   Nof1_HealthAnalysis_{submissionId}_DRAFT.pdf
 */
import { NextRequest, NextResponse } from 'next/server';
import puppeteer from 'puppeteer';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface RouteContext {
  params: { submissionId: string };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { submissionId } = params;

  // Guard: only generate PDFs for submission IDs that have a fixture.
  const fixturePath = join(
    process.cwd(),
    'test-fixtures',
    `health-analysis-${submissionId}.json`,
  );
  if (!existsSync(fixturePath)) {
    return new NextResponse('Health analysis not found', { status: 404 });
  }

  // Derive the base URL from the incoming request so the route is portable
  // across dev, preview, and production without extra configuration.
  const host = request.headers.get('host') ?? 'localhost:3000';
  const isLocal = host.startsWith('localhost') || host.startsWith('127.');
  const protocol = isLocal ? 'http' : 'https';
  const baseUrl = process.env.BASE_URL ?? `${protocol}://${host}`;
  const pageUrl = `${baseUrl}/reports/${submissionId}/health-analysis`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // A4 viewport at 96 dpi — matches the print content width so there is no
    // viewport→print reflow artefact.
    await page.setViewport({ width: 794, height: 1123 });

    // Navigate and wait for fonts, images, and Tailwind CSS to all settle.
    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 30_000 });

    // Belt-and-suspenders CSS: hide the root layout nav/footer that already
    // carry print:hidden Tailwind classes in layout.tsx.  Injected here so the
    // suppression is guaranteed even if layout.tsx changes, and it is invisible
    // to the browser-print path (which reads globals.css directly).
    await page.addStyleTag({
      content: `
        body > header,
        body > footer { display: none !important; }
        body > main {
          max-width: none !important;
          margin:  0 !important;
          padding: 0 !important;
        }
      `,
    });

    // Wait for fonts to be ready (deferred @font-face loads).
    await page.evaluate(() => document.fonts.ready);

    // Physical margin = 0 on all sides so Chrome's CSS @page margins are the
    // sole margin driver — no stacking, full A4 content width, no scale-down.
    // The CSS position:fixed doc-header-wrap and doc-footer-wrap in globals.css
    // render into the 1in @page top/bottom margins on every page, identical to
    // the browser-print path.
    const pdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    const pdf = Buffer.from(pdfBytes);

    const filename = `Nof1_HealthAnalysis_${submissionId}_DRAFT.pdf`;

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[pdf-route] Puppeteer error:', err);
    return new NextResponse(
      `PDF generation failed: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  } finally {
    await browser?.close();
  }
}
