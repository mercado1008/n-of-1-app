/**
 * scripts/generate-docs/health-analysis.ts
 *
 * Generates the Health Analysis .docx for a single submission.
 *
 * 2026-05-13: full section builders for sections 2–7. Sections 2 and 7
 * render per-finding blocks/bullets; sections 3, 4, 5 render structured
 * tables or labelled prose; section 6 renders a mixed shape.
 *
 * Reads: AnalysisOutput (Claude's structured response) + optional
 * RouteAuditBlock (skill/schema/model/timestamp/pdf_sha256 from the
 * route's audit) + optional request metadata (patient/practitioner/test
 * fields from the live-test fixture).
 *
 * Writes: a Buffer that the caller persists to disk.
 *
 * Design constraint: tolerate schema bumps that add fields. All
 * AnalysisOutput fields are typed as optional in types.ts; access
 * defensively and render "(none on this panel)" placeholders for
 * empty source data rather than crashing.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  ImageRun,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  Footer,
  PageNumber,
} from 'docx';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  COLOURS,
  FONTS,
  FONT_SIZES,
  PAGE,
  LOGO,
  SPACING,
  STRINGS,
} from './brand';

import type {
  AnalysisOutput,
  PriorityFinding,
  SubmissionMetadata,
  AuditMetadata,
  RouteAuditBlock,
  RouteGranuleVerification,
} from './types';

// ===========================================================================
// REUSABLE PARAGRAPH AND TABLE FACTORIES
// ===========================================================================

/** A standard body paragraph in Roboto Regular 11pt. */
function bodyParagraph(text: string, opts: { bold?: boolean; spacingAfter?: number } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: opts.spacingAfter ?? SPACING.paragraphAfter },
    children: [
      new TextRun({
        text,
        font: FONTS.body,
        size: FONT_SIZES.body,
        color: COLOURS.black,
        bold: opts.bold ?? false,
      }),
    ],
  });
}

/** An H2 section header in Forest, with a gold underline. */
function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: SPACING.sectionBefore, after: SPACING.sectionAfter },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOURS.gold, space: 4 },
    },
    children: [
      new TextRun({
        text,
        font: FONTS.heading,
        size: FONT_SIZES.h2,
        color: COLOURS.forest,
        bold: true,
      }),
    ],
  });
}

/** A subsection heading (H3) in Forest. */
function subsectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: SPACING.paragraphAfterLoose, after: SPACING.sectionAfter },
    children: [
      new TextRun({
        text,
        font: FONTS.heading,
        size: FONT_SIZES.h3,
        color: COLOURS.forest,
        bold: true,
      }),
    ],
  });
}

/** A small-caption paragraph in grey, italic. */
function captionParagraph(text: string): Paragraph {
  return new Paragraph({
    spacing: { after: SPACING.paragraphAfterTight },
    children: [
      new TextRun({
        text,
        font: FONTS.body,
        size: FONT_SIZES.caption,
        color: COLOURS.greyText,
        italics: true,
      }),
    ],
  });
}

/** A labelled paragraph: "**Label:** body text" in a single line. */
function labelledParagraph(label: string, body: string): Paragraph {
  return new Paragraph({
    spacing: { after: SPACING.paragraphAfterTight },
    children: [
      new TextRun({
        text: `${label}: `,
        font: FONTS.body,
        size: FONT_SIZES.bodySmall,
        color: COLOURS.forest,
        bold: true,
      }),
      new TextRun({
        text: body,
        font: FONTS.body,
        size: FONT_SIZES.bodySmall,
        color: COLOURS.black,
      }),
    ],
  });
}

/** A biomarker block header: name, result, reference range. */
function biomarkerHeader(name: string, result: string, reference: string): Paragraph {
  return new Paragraph({
    spacing: { before: SPACING.paragraphAfter, after: SPACING.paragraphAfterTight },
    children: [
      new TextRun({
        text: name,
        font: FONTS.heading,
        size: FONT_SIZES.body,
        color: COLOURS.forest,
        bold: true,
      }),
      new TextRun({
        text: `   ${result}`,
        font: FONTS.body,
        size: FONT_SIZES.body,
        color: COLOURS.black,
      }),
      new TextRun({
        text: `   (ref: ${reference})`,
        font: FONTS.body,
        size: FONT_SIZES.bodySmall,
        color: COLOURS.greyText,
        italics: true,
      }),
    ],
  });
}

/** A neutral placeholder for empty sections. */
function emptySectionPlaceholder(message: string): Paragraph {
  return new Paragraph({
    spacing: { after: SPACING.paragraphAfter },
    children: [
      new TextRun({
        text: message,
        font: FONTS.body,
        size: FONT_SIZES.bodySmall,
        color: COLOURS.greyText,
        italics: true,
      }),
    ],
  });
}

/** A bulleted item — gold bullet glyph, body text. */
function bulletParagraph(text: string, opts: { indent?: boolean } = {}): Paragraph {
  return new Paragraph({
    spacing: { after: SPACING.paragraphAfterTight },
    indent: opts.indent ? { left: 360 } : undefined,
    children: [
      new TextRun({
        text: '• ',
        font: FONTS.body,
        size: FONT_SIZES.body,
        color: COLOURS.gold,
        bold: true,
      }),
      new TextRun({
        text,
        font: FONTS.body,
        size: FONT_SIZES.bodySmall,
        color: COLOURS.black,
      }),
    ],
  });
}

/** A standard table cell with optional header fill. */
function cell(
  text: string,
  opts: {
    bold?: boolean;
    headerFill?: boolean;
    width?: number;
    align?: typeof AlignmentType[keyof typeof AlignmentType];
    color?: string;
  } = {},
): TableCell {
  const widthValue = opts.width ?? Math.floor(PAGE.contentWidth / 2);
  return new TableCell({
    width: { size: widthValue, type: WidthType.DXA },
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    shading: opts.headerFill
      ? { fill: COLOURS.cloud, type: ShadingType.CLEAR, color: 'auto' }
      : undefined,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOURS.lightGrey },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOURS.lightGrey },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOURS.lightGrey },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOURS.lightGrey },
    },
    children: [
      new Paragraph({
        alignment: opts.align,
        children: [
          new TextRun({
            text,
            font: FONTS.body,
            size: FONT_SIZES.bodySmall,
            color: opts.color ?? COLOURS.black,
            bold: opts.bold ?? false,
          }),
        ],
      }),
    ],
  });
}

/** Map a contraindication severity string to a colour. */
function severityColour(severity?: string): string {
  if (!severity) return COLOURS.greyText;
  const s = severity.toLowerCase();
  if (s.includes('absolute') || s.includes('critical') || s.includes('high')) return COLOURS.draftRed;
  if (s.includes('moderate') || s.includes('caution')) return COLOURS.gold;
  return COLOURS.greyText;
}

// ===========================================================================
// TOP-OF-DOCUMENT ELEMENTS
// ===========================================================================

/** Header band + title + subtitle + DRAFT banner + "not a diagnosis" disclaimer. */
async function buildDocumentHeader(): Promise<Paragraph[]> {
  const logoBuffer = await readFile(path.join(process.cwd(), LOGO.pathHeader));

  return [
    // Brand header band: white "N of 1" wordmark on Forest-green background.
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: SPACING.paragraphAfter },
      children: [
        new ImageRun({
          data: logoBuffer,
          type: 'png',
          transformation: {
            width: LOGO.headerWidthPx,
            height: LOGO.headerHeightPx,
          },
        }),
      ],
    }),
    // Document title
    new Paragraph({
      spacing: { after: SPACING.paragraphAfterTight },
      children: [
        new TextRun({
          text: 'Health Analysis',
          font: FONTS.heading,
          size: FONT_SIZES.h1,
          color: COLOURS.forest,
          bold: true,
        }),
      ],
    }),
    // Subtitle
    new Paragraph({
      spacing: { after: SPACING.paragraphAfterLoose },
      children: [
        new TextRun({
          text: `${STRINGS.productName}  •  ${STRINGS.subline}`,
          font: FONTS.body,
          size: FONT_SIZES.body,
          color: COLOURS.greyText,
          italics: true,
        }),
      ],
    }),
    // DRAFT banner
    new Paragraph({
      spacing: { before: SPACING.paragraphAfter, after: SPACING.paragraphAfterLoose },
      border: {
        top: { style: BorderStyle.SINGLE, size: 6, color: COLOURS.draftRed, space: 2 },
        bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOURS.draftRed, space: 2 },
      },
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: STRINGS.draftBanner,
          font: FONTS.heading,
          size: FONT_SIZES.watermark,
          color: COLOURS.draftRed,
          bold: true,
        }),
      ],
    }),
    // "Not a diagnosis" disclaimer
    new Paragraph({
      spacing: { after: SPACING.paragraphAfterLoose },
      children: [
        new TextRun({
          text: STRINGS.notADiagnosis,
          font: FONTS.body,
          size: FONT_SIZES.caption,
          color: COLOURS.black,
          italics: true,
        }),
      ],
    }),
  ];
}

// ===========================================================================
// SUBMISSION METADATA TABLE
// ===========================================================================

function buildMetadataTable(meta?: SubmissionMetadata, audit?: AuditMetadata): Table {
  const m = meta ?? {};
  const a = audit ?? {};

  const labelCol = 2700;
  const valueCol = 1900;

  const generatedAt = a.generated_at_iso
    ? new Date(a.generated_at_iso).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

  const row = (label1: string, value1: string, label2: string, value2: string) =>
    new TableRow({
      children: [
        cell(label1, { width: labelCol, bold: true, headerFill: true, color: COLOURS.forest }),
        cell(value1, { width: valueCol }),
        cell(label2, { width: labelCol, bold: true, headerFill: true, color: COLOURS.forest }),
        cell(value2, { width: valueCol }),
      ],
    });

  return new Table({
    width: { size: PAGE.contentWidth, type: WidthType.DXA },
    columnWidths: [labelCol, valueCol, labelCol, valueCol],
    rows: [
      row(
        'Patient Pseudonym',
        m.patient_pseudonym ?? '—',
        'Age',
        m.patient_age_years != null ? `${m.patient_age_years}` : '—',
      ),
      row(
        'Sex (at birth)',
        m.patient_sex_assigned_at_birth ?? '—',
        'Test Type',
        m.test_type ?? a.test_type ?? '—',
      ),
      row(
        'Lab ID',
        m.test_lab_id ?? a.test_lab_id ?? '—',
        'Collection Date',
        m.test_collection_date ?? '—',
      ),
      row(
        'Practitioner ID',
        m.practitioner_id ?? a.practitioner_id ?? '—',
        'Practitioner Type',
        m.practitioner_type ?? a.practitioner_type ?? '—',
      ),
      row(
        'Submission ID',
        a.submission_id ?? m.submission_id ?? '—',
        'Generated',
        generatedAt,
      ),
    ],
  });
}

// ===========================================================================
// SECTION 1 — Executive Summary
// ===========================================================================

function buildExecutiveSummary(output: AnalysisOutput): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 1 — Executive Summary'));

  if (output.executive_summary?.headline) {
    elements.push(
      bodyParagraph(output.executive_summary.headline, {
        spacingAfter: SPACING.paragraphAfterLoose,
      }),
    );
  }

  const findings = output.executive_summary?.priority_findings ?? [];
  if (findings.length > 0) {
    elements.push(subsectionHeading('Priority findings for practitioner consideration'));
    elements.push(buildPriorityFindingsTable(findings));
    return elements;
  }

  // Fallback: render recognised patterns as bullets
  const patterns = output.recognised_patterns ?? [];
  if (patterns.length > 0) {
    elements.push(subsectionHeading('Recognised clinical patterns'));
    for (const p of patterns) {
      elements.push(
        new Paragraph({
          spacing: { after: SPACING.paragraphAfterTight },
          children: [
            new TextRun({
              text: '• ',
              font: FONTS.body,
              size: FONT_SIZES.body,
              color: COLOURS.gold,
              bold: true,
            }),
            new TextRun({
              text: p.pattern_name ?? '—',
              font: FONTS.body,
              size: FONT_SIZES.body,
              color: COLOURS.black,
              bold: true,
            }),
          ],
        }),
      );
      if (p.supporting_findings) {
        const supports = Array.isArray(p.supporting_findings)
          ? p.supporting_findings.join(', ')
          : p.supporting_findings;
        elements.push(
          new Paragraph({
            spacing: { after: SPACING.paragraphAfter },
            indent: { left: 360 },
            children: [
              new TextRun({
                text: `Supporting findings: ${supports}`,
                font: FONTS.body,
                size: FONT_SIZES.bodySmall,
                color: COLOURS.greyText,
              }),
            ],
          }),
        );
      }
    }
  } else {
    elements.push(emptySectionPlaceholder('(No priority findings or recognised patterns populated in this output.)'));
  }

  return elements;
}

function buildPriorityFindingsTable(findings: PriorityFinding[]): Table {
  const colWidths = [
    Math.floor(PAGE.contentWidth * 0.12),
    Math.floor(PAGE.contentWidth * 0.28),
    Math.floor(PAGE.contentWidth * 0.22),
    Math.floor(PAGE.contentWidth * 0.38),
  ];

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell('Priority', { width: colWidths[0], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Finding', { width: colWidths[1], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Result vs Reference', { width: colWidths[2], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('For Practitioner Consideration', { width: colWidths[3], bold: true, headerFill: true, color: COLOURS.forest }),
    ],
  });

  const dataRows = findings.map((f) =>
    new TableRow({
      children: [
        cell(f.priority ?? '—', { width: colWidths[0], bold: true }),
        cell(f.finding ?? '—', { width: colWidths[1] }),
        cell(f.result_vs_reference ?? '—', { width: colWidths[2] }),
        cell(f.for_practitioner_consideration ?? '—', { width: colWidths[3] }),
      ],
    }),
  );

  return new Table({
    width: { size: PAGE.contentWidth, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows],
  });
}

// ===========================================================================
// SECTION 2 — Detailed Biomarker Analysis
// ===========================================================================

function buildSection2(output: AnalysisOutput): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 2 — Detailed Biomarker Analysis'));

  const findings = output.biomarker_analysis ?? [];
  if (findings.length === 0) {
    elements.push(emptySectionPlaceholder('(No biomarker findings populated in this output.)'));
    return elements;
  }

  elements.push(
    bodyParagraph(
      `The following ${findings.length} biomarker findings are surfaced for practitioner review. Each finding includes a hedged interpretation, possible contributors per the published literature, and the relevance of the finding to the formulation strategy.`,
      { spacingAfter: SPACING.paragraphAfterLoose },
    ),
  );

  for (const f of findings) {
    const name = (f as any).biomarker ?? '—';
    const result = (f as any).result ?? '—';
    const reference = (f as any).laboratory_reference_range ?? (f as any).reference ?? '—';
    const interpretation = (f as any).interpretation ?? (f as any).pattern_note ?? null;
    const contributors = (f as any).possible_contributors_per_published_literature ?? null;
    const relevance = (f as any).relevance_to_formulation ?? null;

    elements.push(biomarkerHeader(name, String(result), String(reference)));
    if (interpretation) elements.push(labelledParagraph('Interpretation', interpretation));
    if (contributors) elements.push(labelledParagraph('Possible contributors', contributors));
    if (relevance) elements.push(labelledParagraph('Relevance to formulation', relevance));
  }

  return elements;
}

// ===========================================================================
// SECTION 3 — Diet and Lifestyle Considerations
// ===========================================================================

function buildSection3(output: AnalysisOutput): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 3 — Diet and Lifestyle Considerations'));

  const items = output.diet_lifestyle_considerations ?? [];
  if (items.length === 0) {
    elements.push(emptySectionPlaceholder('(No diet or lifestyle considerations populated in this output.)'));
    return elements;
  }

  elements.push(
    bodyParagraph(
      'The following considerations are surfaced for practitioner-led discussion. They sit alongside the recommended formulation rather than substituting for it.',
      { spacingAfter: SPACING.paragraphAfterLoose },
    ),
  );

  for (const item of items) {
    const category = (item as any).category ?? '—';
    const consideration =
      (item as any).consideration_for_practitioner_discussion ?? (item as any).consideration ?? '—';
    const rationale = (item as any).rationale ?? null;

    elements.push(
      new Paragraph({
        spacing: { before: SPACING.paragraphAfter, after: SPACING.paragraphAfterTight },
        children: [
          new TextRun({
            text: category,
            font: FONTS.heading,
            size: FONT_SIZES.body,
            color: COLOURS.forest,
            bold: true,
          }),
        ],
      }),
    );
    elements.push(labelledParagraph('Consideration', consideration));
    if (rationale) elements.push(labelledParagraph('Rationale', rationale));
  }

  return elements;
}

// ===========================================================================
// SECTION 4 — Recommended Formulation Logic
// ===========================================================================

function buildSection4(output: AnalysisOutput): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 4 — Recommended Formulation Logic'));

  const fl = output.formulation_logic as any;
  if (!fl || Object.keys(fl).length === 0) {
    elements.push(emptySectionPlaceholder('(No formulation logic populated in this output.)'));
    return elements;
  }

  if (fl.overall_strategy) {
    elements.push(subsectionHeading('Overall strategy'));
    elements.push(bodyParagraph(fl.overall_strategy));
  }
  const included: unknown = fl.what_was_intentionally_included_and_why;
  if (Array.isArray(included) && included.length > 0) {
    elements.push(subsectionHeading('What was intentionally included, and why'));
    for (const item of included) {
      elements.push(bulletParagraph(typeof item === 'string' ? item : String(item)));
    }
  }

  const excluded: unknown = fl.what_was_intentionally_excluded_and_why;
  if (Array.isArray(excluded) && excluded.length > 0) {
    elements.push(subsectionHeading('What was intentionally excluded, and why'));
    for (const item of excluded) {
      if (item && typeof item === 'object' && 'excluded' in item && 'reason' in item) {
        const e = item as { excluded: string; reason: string };
        elements.push(bulletParagraph(`${e.excluded} — ${e.reason}`));
      } else {
        elements.push(bulletParagraph(String(item)));
      }
    }
  }

  elements.push(
    bodyParagraph(
      'The detailed ingredient-by-ingredient formulation, including doses, granule counts, and per-ingredient rationale, is in the companion Recommended Formulation Schedule (.xlsx).',
      { spacingAfter: SPACING.paragraphAfterLoose },
    ),
  );

  return elements;
}

// ===========================================================================
// SECTION 5 — Contraindication and Interaction Considerations
// ===========================================================================

function buildSection5(output: AnalysisOutput, tsiResolver?: TsiResolver): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 5 — Contraindication and Interaction Considerations'));

  const flags = output.contraindication_flags ?? [];
  const exclusions = output.binding_exclusions_applied ?? [];

  // Contraindication flags
  elements.push(subsectionHeading('Contraindication flags'));
  if (flags.length === 0) {
    elements.push(emptySectionPlaceholder('(No contraindication flags raised on this panel.)'));
  } else {
    elements.push(
      bodyParagraph(
        `${flags.length} contraindication or interaction consideration(s) raised for practitioner review.`,
        { spacingAfter: SPACING.paragraphAfter },
      ),
    );
    elements.push(buildContraindicationTable(flags, tsiResolver));
  }

  // Binding exclusions
  elements.push(subsectionHeading('Binding exclusions applied'));
  if (exclusions.length === 0) {
    elements.push(
      emptySectionPlaceholder(
        '(No binding exclusions applied on this panel — none of the panel findings triggered a hard exclusion rule.)',
      ),
    );
  } else {
    elements.push(
      bodyParagraph(
        `${exclusions.length} binding exclusion(s) applied. These are ingredients held out of the pod because the panel does not measure the data needed to confirm safety, or the panel data crossed a hard exclusion threshold.`,
        { spacingAfter: SPACING.paragraphAfter },
      ),
    );
    elements.push(buildBindingExclusionTable(exclusions));
  }

  return elements;
}

function buildContraindicationTable(flags: AnalysisOutput['contraindication_flags'], tsiResolver?: TsiResolver): Table {
  const cols = [
    Math.floor(PAGE.contentWidth * 0.14),
    Math.floor(PAGE.contentWidth * 0.22),
    Math.floor(PAGE.contentWidth * 0.46),
    Math.floor(PAGE.contentWidth * 0.18),
  ];

  const header = new TableRow({
    tableHeader: true,
    children: [
      cell('Severity', { width: cols[0], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Flag', { width: cols[1], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Description', { width: cols[2], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Affected Ingredient(s)', { width: cols[3], bold: true, headerFill: true, color: COLOURS.forest }),
    ],
  });

  const dataRows = (flags ?? []).map((f) => {
    const severity = (f as any).severity ?? '—';
    const flag = (f as any).flag ?? (f as any).ingredient ?? '—';
    const description = (f as any).description ?? (f as any).interaction_or_contraindication ?? '—';
    const tsiCodes = (f as any).affected_tsi_codes;
    // Resolve TSI codes to common ingredient names. If no resolver supplied,
    // or if a code isn't in the Library, the cell shows '—' rather than
    // leaking an internal code into a practitioner-facing document.
    const ingredientText = Array.isArray(tsiCodes) && tsiCodes.length > 0
      ? tsiCodes
          .map((code: string) => tsiResolver?.(code) ?? '—')
          .filter((name: string) => name !== '—')
          .join(', ') || '—'
      : '—';
    return new TableRow({
      children: [
        cell(severity, { width: cols[0], bold: true, color: severityColour(severity) }),
        cell(flag, { width: cols[1] }),
        cell(description, { width: cols[2] }),
        cell(ingredientText, { width: cols[3] }),
      ],
    });
  });

  return new Table({
    width: { size: PAGE.contentWidth, type: WidthType.DXA },
    columnWidths: cols,
    rows: [header, ...dataRows],
  });
}

function buildBindingExclusionTable(exclusions: AnalysisOutput['binding_exclusions_applied']): Table {
  const cols = [
    Math.floor(PAGE.contentWidth * 0.22),
    Math.floor(PAGE.contentWidth * 0.38),
    Math.floor(PAGE.contentWidth * 0.40),
  ];

  const header = new TableRow({
    tableHeader: true,
    children: [
      cell('Ingredient', { width: cols[0], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Trigger', { width: cols[1], bold: true, headerFill: true, color: COLOURS.forest }),
      cell('Practitioner Note', { width: cols[2], bold: true, headerFill: true, color: COLOURS.forest }),
    ],
  });

  const dataRows = (exclusions ?? []).map((e) =>
    new TableRow({
      children: [
        cell((e as any).ingredient ?? '—', { width: cols[0], bold: true }),
        cell((e as any).finding_trigger ?? (e as any).trigger ?? '—', { width: cols[1] }),
        cell((e as any).practitioner_note ?? '—', { width: cols[2] }),
      ],
    }),
  );

  return new Table({
    width: { size: PAGE.contentWidth, type: WidthType.DXA },
    columnWidths: cols,
    rows: [header, ...dataRows],
  });
}

// ===========================================================================
// SECTION 6 — Monitoring and Follow-Up Considerations
// ===========================================================================

function buildSection6(output: AnalysisOutput): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 6 — Monitoring and Follow-Up Considerations'));

  const mc = output.monitoring_considerations as any;
  if (!mc || Object.keys(mc).length === 0) {
    elements.push(emptySectionPlaceholder('(No monitoring considerations populated in this output.)'));
    return elements;
  }

  if (mc.summary) {
    elements.push(bodyParagraph(mc.summary));
  }

  const markers =
    mc.markers_for_practitioner_consideration_at_follow_up ?? mc.priority_markers ?? [];
  if (Array.isArray(markers) && markers.length > 0) {
    elements.push(subsectionHeading('Markers for practitioner consideration at follow-up'));
    for (const m of markers) {
      if (typeof m === 'string') {
        elements.push(bulletParagraph(m));
      } else if (m && typeof m === 'object') {
        const marker = (m as any).marker ?? '—';
        const consideration = (m as any).consideration ?? '';
        elements.push(bulletParagraph(consideration ? `${marker} — ${consideration}` : marker));
      }
    }
  }

  if (mc.framing) {
    elements.push(
      new Paragraph({
        spacing: { before: SPACING.paragraphAfterLoose, after: SPACING.paragraphAfter },
        children: [
          new TextRun({
            text: mc.framing,
            font: FONTS.body,
            size: FONT_SIZES.bodySmall,
            color: COLOURS.greyText,
            italics: true,
          }),
        ],
      }),
    );
  } else if (mc.general_notes) {
    elements.push(bodyParagraph(mc.general_notes));
  }

  return elements;
}

// ===========================================================================
// SECTION 7 — Areas of Strength
// ===========================================================================

function buildSection7(output: AnalysisOutput): Array<Paragraph | Table> {
  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('Section 7 — Areas of Strength'));

  const items = output.areas_of_strength ?? [];
  if (items.length === 0) {
    elements.push(emptySectionPlaceholder('(No within-reference findings highlighted on this panel.)'));
    return elements;
  }

  elements.push(
    bodyParagraph(
      `The following ${items.length} finding(s) on this panel are within reference and are surfaced as areas of clinical strength to contextualise the abnormal findings above.`,
      { spacingAfter: SPACING.paragraphAfter },
    ),
  );

  for (const item of items) {
    if (typeof item === 'string') {
      elements.push(bulletParagraph(item));
    } else if (item && typeof item === 'object') {
      const marker = (item as any).marker ?? '';
      const result = (item as any).result ?? '';
      const note = (item as any).practitioner_note ?? (item as any).consideration ?? '';
      const parts = [marker, result, note].filter(Boolean);
      elements.push(bulletParagraph(parts.join(' — ')));
    }
  }

  return elements;
}

// ===========================================================================
// SECTIONS 2–7 ORCHESTRATOR
// ===========================================================================

function buildAllSections(output: AnalysisOutput, tsiResolver?: TsiResolver): Array<Paragraph | Table> {
  return [
    ...buildSection2(output),
    ...buildSection3(output),
    ...buildSection4(output),
    ...buildSection5(output, tsiResolver),
    ...buildSection6(output),
    ...buildSection7(output),
  ];
}

// ===========================================================================
// REFERENCES SECTION
// ===========================================================================

/**
 * Build a numbered reference list from the evidence_pointer fields on each
 * proposed ingredient. Entries with identical pointers are grouped under a
 * single reference number. Placed at the end of the document before the
 * closing disclaimer so the practitioner can follow up on the evidence base
 * for each formulation decision.
 */
function buildReferencesSection(output: AnalysisOutput): Array<Paragraph | Table> {
  // v0.4.7+: prefer top-level references array (one citation per ingredient,
  // generated after formulation arithmetic is finalised).
  // Fall back to per-ingredient evidence_pointer for older outputs.
  const topLevelRefs = output.references ?? [];
  const proposed = output.proposed_formulation ?? [];

  // Build citation → ingredient name map.
  // Top-level references take precedence; evidence_pointer is the legacy fallback.
  const citationToNames = new Map<string, string[]>();

  if (topLevelRefs.length > 0) {
    for (const ref of topLevelRefs) {
      const citation = ref.citation?.trim();
      const name = ref.ingredient_name?.trim() ?? '(unnamed)';
      if (!citation) continue;
      const names = citationToNames.get(citation) ?? [];
      if (!names.includes(name)) names.push(name);
      citationToNames.set(citation, names);
    }
  } else {
    // Legacy fallback: evidence_pointer per ingredient
    for (const ing of proposed) {
      const pointer = ing.evidence_pointer?.trim();
      if (!pointer) continue;
      const name = ing.common_name ?? ing.ingredient_name ?? ing.tsi_code ?? '(unnamed)';
      const names = citationToNames.get(pointer) ?? [];
      if (!names.includes(name)) names.push(name);
      citationToNames.set(pointer, names);
    }
  }

  if (citationToNames.size === 0) return [];

  const hasProperCitations = topLevelRefs.length > 0;

  const elements: Array<Paragraph | Table> = [];
  elements.push(sectionHeading('References'));
  elements.push(
    bodyParagraph(
      hasProperCitations
        ? 'Key published studies cited by the clinical decision support system in support of each formulation decision. Citations should be independently verified by the reviewing practitioner before clinical reliance. PMIDs and DOIs can be confirmed via PubMed (pubmed.ncbi.nlm.nih.gov).'
        : 'Evidence areas cited by the clinical decision support system for each ingredient. The reviewing practitioner should consult primary literature as required.',
      { spacingAfter: SPACING.paragraphAfterLoose },
    ),
  );

  let n = 1;
  for (const [citation, names] of Array.from(citationToNames.entries())) {
    elements.push(
      new Paragraph({
        spacing: { after: SPACING.paragraphAfter },
        children: [
          new TextRun({
            text: `[${n}]`,
            font: FONTS.body,
            size: FONT_SIZES.body,
            color: COLOURS.gold,
            bold: true,
          }),
          new TextRun({
            text: `  ${citation}`,
            font: FONTS.body,
            size: FONT_SIZES.body,
            color: COLOURS.black,
          }),
          new TextRun({
            text: `  (${names.join(', ')})`,
            font: FONTS.body,
            size: FONT_SIZES.caption,
            color: COLOURS.black,
            italics: true,
          }),
        ],
      }),
    );
    n++;
  }

  return elements;
}

// ===========================================================================
// CLOSING DISCLAIMER + AUDIT FOOTER
// ===========================================================================

function buildClosingDisclaimer(): Paragraph[] {
  return [
    new Paragraph({
      spacing: { before: SPACING.sectionBefore, after: SPACING.paragraphAfter },
      border: {
        top: { style: BorderStyle.SINGLE, size: 6, color: COLOURS.gold, space: 4 },
      },
      children: [
        new TextRun({
          text: STRINGS.patientActionWarning,
          font: FONTS.body,
          size: FONT_SIZES.caption,
          color: COLOURS.black,
          italics: true,
          bold: true,
        }),
      ],
    }),
  ];
}

/**
 * Compute a deterministic, opaque audit reference from the route-side audit
 * fields. Same inputs → same reference. The reference appears on the document;
 * the full audit state (skill_version, prompt_version, schema_version,
 * library_revision, model, pdf_sha256) lives in a separate audit log keyed
 * by submission_id, queryable for regulatory inquiry.
 *
 * Design intent: the document carries no version strings or model names that
 * could identify its production pipeline. The audit reference is an opaque
 * tracking number that looks like routine document furniture.
 */
function computeAuditReference(
  output: AnalysisOutput,
  routeAudit?: RouteAuditBlock,
): string {
  const r = routeAudit ?? {};
  const a = output.audit_metadata ?? {};
  const inputs = [
    r.submission_id ?? a.submission_id ?? output.submission_metadata?.submission_id ?? '',
    r.system_prompt_version ?? a.system_prompt_version ?? a.prompt_version ?? '',
    r.output_schema_version ?? a.output_schema_version ?? '',
    String(r.library_revision ?? a.library_revision ?? ''),
    r.skill_version ?? a.skill_version ?? '',
    r.pdf_sha256 ?? a.pdf_sha256 ?? '',
  ].join('|');
  const hash = createHash('sha256').update(inputs).digest('hex');
  // 12 hex chars, formatted as 3 groups of 4 separated by '-'.
  const hex = hash.slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Format the audit footer. Reads from the route-side audit block (authoritative)
 *  then falls back to Claude's narrower audit_metadata. */
function buildAuditFooter(output: AnalysisOutput, routeAudit?: RouteAuditBlock): Paragraph[] {
  const r = routeAudit ?? {};
  const a = output.audit_metadata ?? {};

  const submission =
    r.submission_id ?? a.submission_id ?? output.submission_metadata?.submission_id ?? '—';
  const generated = r.generated_at_iso ?? a.generated_at_iso;
  const generatedStr = generated
    ? new Date(generated).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
  const auditReference = computeAuditReference(output, routeAudit);

  // Two-line opaque footer: looks like routine document furniture, carries
  // no version strings or model names. The full audit state lives in a
  // separate audit log keyed by submission_id / audit reference.
  return [
    captionParagraph(`Submission: ${submission}  •  Generated: ${generatedStr}`),
    captionParagraph(`Audit Reference: ${auditReference}`),
  ];
}

// ===========================================================================
// PAGE FOOTER (persistent across pages)
// ===========================================================================

function buildPageFooter(submissionId?: string): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `${STRINGS.productName}  |  ${submissionId ?? 'no submission id'}  |  DRAFT — Page `,
            font: FONTS.body,
            size: FONT_SIZES.caption_xs,
            color: COLOURS.greyText,
          }),
          new TextRun({
            children: [PageNumber.CURRENT],
            font: FONTS.body,
            size: FONT_SIZES.caption_xs,
            color: COLOURS.greyText,
          }),
          new TextRun({
            text: ' of ',
            font: FONTS.body,
            size: FONT_SIZES.caption_xs,
            color: COLOURS.greyText,
          }),
          new TextRun({
            children: [PageNumber.TOTAL_PAGES],
            font: FONTS.body,
            size: FONT_SIZES.caption_xs,
            color: COLOURS.greyText,
          }),
        ],
      }),
    ],
  });
}

// ===========================================================================
// PUBLIC ENTRY POINT
// ===========================================================================

// Resolver function: maps a tsi_code to a display-friendly ingredient name.
// Built once from the Library by the orchestrator and passed in.
export type TsiResolver = (tsiCode: string) => string | undefined;

export interface GenerateHealthAnalysisOptions {
  output: AnalysisOutput;
  // Optional: the request metadata that was submitted with the PDF.
  requestMetadata?: {
    submission_id?: string;
    practitioner_id?: string;
    practitioner_type?: string;
    practitioner_name?: string;
    patient_pseudonym?: string;
    patient_age_years?: number;
    patient_sex_assigned_at_birth?: string;
    test_type?: string;
    test_lab_id?: string;
    test_collection_date?: string;
    panel_classes?: string[];
  };
  // Optional: route's audit block (skill/schema/model/timestamp/pdf_sha256).
  routeAudit?: RouteAuditBlock;
  // Optional: TSI code → common name resolver for ingredient labels.
  // Without this, contraindication-table ingredient names fall back to "—".
  tsiResolver?: TsiResolver;
  // Optional: route's granule verification block (reserved for future use).
  granuleVerification?: RouteGranuleVerification;
}

/**
 * Build the Health Analysis docx for a single submission and return
 * the file as a Buffer. The caller persists to disk.
 */
export async function generateHealthAnalysis(
  opts: GenerateHealthAnalysisOptions,
): Promise<Buffer> {
  const { output, requestMetadata } = opts;

  if (output.output_type === 'refusal') {
    return buildRefusalDocument(output, opts.routeAudit);
  }

  // Merge metadata sources: request metadata is authoritative for patient/test
  // data; Claude's submission_metadata is a fallback; audit_metadata fills gaps.
  const mergedSubmissionMetadata: SubmissionMetadata = {
    ...output.submission_metadata,
    ...(requestMetadata ?? {}),
  };

  const headerElements = await buildDocumentHeader();
  const metadataTable = buildMetadataTable(mergedSubmissionMetadata, output.audit_metadata);
  const executiveSummary = buildExecutiveSummary(output);
  const allSections = buildAllSections(output, opts.tsiResolver);
  const referencesSection = buildReferencesSection(output);
  const closingDisclaimer = buildClosingDisclaimer();
  const auditFooter = buildAuditFooter(output, opts.routeAudit);

  const submissionId =
    mergedSubmissionMetadata.submission_id ?? output.audit_metadata?.submission_id;

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONTS.body, size: FONT_SIZES.body, color: COLOURS.black },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: PAGE.margins,
          },
        },
        footers: { default: buildPageFooter(submissionId) },
        children: [
          ...headerElements,
          metadataTable,
          new Paragraph({ children: [new TextRun('')] }), // breathing room
          ...executiveSummary,
          ...allSections,
          ...referencesSection,
          ...closingDisclaimer,
          ...auditFooter,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}

/** Minimal refusal-path document — single page, refusal explanation. */
async function buildRefusalDocument(
  output: AnalysisOutput,
  routeAudit?: RouteAuditBlock,
): Promise<Buffer> {
  const headerElements = await buildDocumentHeader();
  const refusalSection: Paragraph[] = [
    sectionHeading('Refusal'),
    bodyParagraph(`Trigger: ${output.refusal_trigger ?? '—'}`, { bold: true }),
    bodyParagraph(output.refusal_explanation ?? '—'),
    bodyParagraph(
      output.escalation_recommended
        ? 'Escalation: this submission has been flagged for practitioner review.'
        : 'Escalation: not flagged.',
      { spacingAfter: SPACING.paragraphAfterLoose },
    ),
  ];
  const auditFooter = buildAuditFooter(output, routeAudit);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONTS.body, size: FONT_SIZES.body, color: COLOURS.black },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE.width, height: PAGE.height },
            margin: PAGE.margins,
          },
        },
        children: [...headerElements, ...refusalSection, ...auditFooter],
      },
    ],
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}
