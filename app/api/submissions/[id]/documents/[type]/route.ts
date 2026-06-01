import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { getDocumentPath, DOCUMENT_NAMES } from '@/lib/submissions';

export const runtime = 'nodejs';

const TYPE_MAP: Record<string, { key: keyof typeof DOCUMENT_NAMES; mime: string; ext: string }> = {
  'health-analysis': {
    key: 'healthAnalysis',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: 'docx',
  },
  'formulation-schedule': {
    key: 'formulationSchedule',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
};

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; type: string } },
) {
  const { id, type } = params;
  const config = TYPE_MAP[type];
  if (!config) {
    return NextResponse.json({ error: 'Unknown document type' }, { status: 400 });
  }

  try {
    const filePath = await getDocumentPath(id, config.key);
    const buffer = await readFile(filePath);
    const filename = `Nof1_${type === 'health-analysis' ? 'HealthAnalysis' : 'FormulationSchedule'}_${id}_DRAFT.${config.ext}`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': config.mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  }
}
