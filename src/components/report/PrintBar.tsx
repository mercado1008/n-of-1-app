/**
 * PrintBar
 *
 * Sticky toolbar rendered above the Health Analysis document on screen.
 * Hidden in print via Tailwind's `print:hidden` utility so it never appears
 * in the Puppeteer PDF or a browser print preview.
 *
 * - "Download PDF" link  → /api/reports/[submissionId]/pdf  (Puppeteer route)
 * - "Print" button       → window.print()  (browser print dialog, for quick checks)
 *
 * This is a Client Component ('use client') because the Print button calls
 * window.print() — a browser-only API unavailable in Server Components.
 */
'use client';

interface PrintBarProps {
  submissionId: string;
}

export function PrintBar({ submissionId }: PrintBarProps) {
  return (
    <div className="print:hidden sticky top-0 z-50 bg-white/95 backdrop-blur-sm border-b border-gray-200 px-6 py-2.5 flex items-center justify-between gap-4">
      <span
        className="text-xs text-gray-500 tracking-wide"
        style={{ fontFamily: 'var(--font-jost, Arial, sans-serif)' }}
      >
        Health Analysis &nbsp;·&nbsp; {submissionId} &nbsp;·&nbsp; Draft
      </span>

      <div className="flex gap-2">
        {/* Puppeteer-generated PDF — full colours, running headers, correct margins */}
        <a
          href={`/api/reports/${submissionId}/pdf`}
          download
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors"
          style={{
            fontFamily: 'var(--font-jost, Arial, sans-serif)',
            backgroundColor: '#535B50',
            color: '#ffffff',
          }}
          onMouseOver={(e) => { (e.currentTarget as HTMLAnchorElement).style.backgroundColor = '#3f4741'; }}
          onMouseOut={(e) => { (e.currentTarget as HTMLAnchorElement).style.backgroundColor = '#535B50'; }}
        >
          ↓ Download PDF
        </a>

        {/* Browser print dialog — useful for quick layout checks */}
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          style={{ fontFamily: 'var(--font-jost, Arial, sans-serif)' }}
        >
          Print
        </button>
      </div>
    </div>
  );
}
