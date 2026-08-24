/**
 * /reports/[submissionId]/health-analysis
 *
 * Practitioner review route for the branded Health Analysis document.
 *
 * Data loading (dev-only fixture strategy):
 *   Reads `test-fixtures/health-analysis-{submissionId}.json` from the
 *   project root. Returns 404 if the fixture is absent.
 *
 *   TODO (step 4 → production): replace the fixture read with a real data
 *   loader once persistence is wired (see STATUS.md "Architectural extensions").
 *
 * This is a Server Component — no 'use client' needed.
 */
import { notFound } from 'next/navigation';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HealthAnalysis } from '../../../../src/lib/health-analysis-schema';
import { HealthAnalysisDocument } from '../../../../src/components/report/HealthAnalysisDocument';
import { PrintBar } from '../../../../src/components/report/PrintBar';

interface PageProps {
  params: { submissionId: string };
}

export default function HealthAnalysisPage({ params }: PageProps) {
  const { submissionId } = params;

  // process.cwd() is always the project root in Next.js dev and build modes.
  const fixturePath = join(
    process.cwd(),
    'test-fixtures',
    `health-analysis-${submissionId}.json`,
  );

  if (!existsSync(fixturePath)) notFound();

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch {
    notFound();
  }

  const result = HealthAnalysis.safeParse(raw);

  if (!result.success) {
    // Surface schema errors during development — never reached in a well-formed fixture.
    return (
      <div className="p-8 font-mono text-sm">
        <h2 className="text-red-600 font-bold mb-4">
          Invalid health-analysis fixture for {submissionId}
        </h2>
        <pre className="text-red-700 whitespace-pre-wrap text-xs">
          {JSON.stringify(result.error.issues, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <>
      <PrintBar submissionId={submissionId} />
      <HealthAnalysisDocument doc={result.data} />
    </>
  );
}

// Generate page metadata from the fixture's submission ID.
export function generateMetadata({ params }: PageProps) {
  return {
    title: `Health Analysis — ${params.submissionId} | N of 1`,
  };
}
