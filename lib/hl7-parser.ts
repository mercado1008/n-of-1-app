/**
 * lib/hl7-parser.ts
 *
 * Parse raw HL7 v2 text into typed segment arrays.
 * Handles: pipe field separator (|), caret component separator (^),
 * and \r\n / \r / \n line endings.
 *
 * Repetitions (~) and subcomponents (&) are not decoded — the OBX fields
 * needed for biomarker extraction use plain single-valued components.
 */

export interface HL7Field {
  /** Raw field string (may contain ^ component separators). */
  raw: string;
  /** Components split on '^'. Zero-indexed: components[0] = first component (HL7 .1). */
  components: string[];
}

export interface HL7Segment {
  /** Segment type identifier, e.g. 'MSH', 'OBX', 'PID'. */
  name: string;
  /**
   * All fields including the segment name at index 0.
   * fields[n] === HL7 field n, 1-indexed per HL7 spec (field 1 is at fields[1]).
   */
  fields: HL7Field[];
}

function makeField(raw: string): HL7Field {
  return { raw, components: raw.split('^') };
}

export function parseHL7Message(raw: string): HL7Segment[] {
  return raw
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(l => l.length >= 3)
    .map(line => ({
      name: line.slice(0, 3),
      fields: line.split('|').map(makeField),
    }));
}

/**
 * Return the field at 1-indexed position idx. Returns an empty field if absent.
 * Example: field(seg, 3) = OBX-3 = Observation Identifier.
 */
export function field(seg: HL7Segment, idx: number): HL7Field {
  return seg.fields[idx] ?? { raw: '', components: [''] };
}

/**
 * Return a specific component (0-indexed) from the field at 1-indexed position idx.
 * Example: comp(seg, 3, 0) = OBX-3.1 = local code; comp(seg, 3, 1) = OBX-3.2 = display name.
 */
export function comp(seg: HL7Segment, fieldIdx: number, compIdx: number): string {
  return field(seg, fieldIdx).components[compIdx] ?? '';
}
