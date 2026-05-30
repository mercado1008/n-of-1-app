/**
 * scripts/generate-docs/brand.ts
 *
 * N of 1 brand constants for document generation.
 * Colour codes, font names, image paths, common dimensions.
 *
 * Brand reference: see Mini Brand Style Guide.
 * Logo: black-flat-gold variant for white-page printing.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Colours (hex without leading #, as docx-js expects)
// ---------------------------------------------------------------------------

export const COLOURS = {
  white: 'FFFFFF',
  black: '000000',
  gold: 'C3AF88',       // accent — section rules, key emphasis
  forest: '535B50',     // primary brand — headings, body emphasis
  sageGreen: 'A7B7A5',  // secondary — table headers, callout fills
  cloud: 'E2E0D9',      // neutral background — metadata blocks, alternating rows
  // Functional shades for clinical content
  draftRed: '8B2A2A',   // muted red for DRAFT watermark text (not bright red — keeps brand-aligned tone)
  greyText: '666666',   // secondary text (timestamps, audit metadata)
  lightGrey: 'CCCCCC',  // table borders
} as const;

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

// Roboto is the brand standard; system fallbacks if Roboto not installed.
// docx-js applies font family at the run level, not the document level.
export const FONTS = {
  body: 'Roboto',
  heading: 'Roboto',
  // Fallback font that exists on every system (used if Roboto is missing).
  // Word/macOS will substitute automatically; we declare Roboto explicitly
  // so the document carries brand intent.
  fallback: 'Arial',
} as const;

// ---------------------------------------------------------------------------
// Font sizes — docx-js uses half-points
// (e.g. 24 = 12pt, 22 = 11pt, 20 = 10pt, 18 = 9pt, 16 = 8pt)
// ---------------------------------------------------------------------------

export const FONT_SIZES = {
  body: 22,           // 11pt — practitioner-document body text
  bodySmall: 20,      // 10pt — table content
  caption: 18,        // 9pt — footnotes, audit metadata
  caption_xs: 16,     // 8pt — fine print
  h1: 36,             // 18pt — document title
  h2: 28,             // 14pt — section headers
  h3: 24,             // 12pt — subsection headers
  watermark: 22,      // 11pt — DRAFT band text
} as const;

// ---------------------------------------------------------------------------
// Page layout (DXA — 1440 = 1 inch)
// ---------------------------------------------------------------------------

export const PAGE = {
  // A4 portrait — Australian default
  width: 11906,
  height: 16838,
  margins: {
    top: 1080,    // 0.75"
    right: 1440,  // 1.0"
    bottom: 1080, // 0.75"
    left: 1440,   // 1.0"
  },
  // Content width with 1" left + 1" right margins
  contentWidth: 11906 - 1440 - 1440, // 9026 DXA
} as const;

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

// Path resolved relative to project root, where npm scripts run.
// The header band is a pre-composited image: white "N of 1" wordmark on
// Forest-green background. Avoids transparency rendering issues across
// docx clients and provides the brand-band visual anchor.
export const LOGO = {
  pathHeader: path.join('assets', 'brand', 'nof1_header_band.png'),
  // Header band display — proportional to native 1600×300 (5.33:1)
  headerWidthPx: 540,   // ~6 inches at 90 DPI; fills the content area
  headerHeightPx: 101,  // proportional
} as const;

// ---------------------------------------------------------------------------
// Common spacings (twentieths of a point)
// ---------------------------------------------------------------------------

export const SPACING = {
  paragraphAfter: 120,        // 6pt after paragraph
  paragraphAfterTight: 60,    // 3pt
  paragraphAfterLoose: 240,   // 12pt
  sectionBefore: 360,         // 18pt before section header
  sectionAfter: 180,          // 9pt after section header
} as const;

// ---------------------------------------------------------------------------
// Common strings
// ---------------------------------------------------------------------------

export const STRINGS = {
  productName: 'N of 1 Precision Formulation',
  subline: 'Practitioner Decision Support',
  draftBanner: 'DRAFT — PENDING PRACTITIONER REVIEW AND APPROVAL',
  notADiagnosis: 'This document is decision support for a qualified healthcare practitioner. It is not a diagnosis, not a prescription, and not directed to the patient. The reviewing practitioner is the prescribing clinician of record and exercises independent clinical judgement on every recommendation contained herein.',
  patientActionWarning: 'Patients should not act on the contents of this document without the direct guidance of their treating practitioner.',
} as const;
