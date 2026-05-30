/**
 * lib/hl7-adapter.ts
 *
 * Transform a raw HL7 v2.3.1 ORU^R01 message into the internal
 * ParsedHL7Message shape used by the HL7 user-prompt builder.
 *
 * PID   → patient provenance (id, dob, sex)
 * OBR   → test provenance (order id, collection datetime)
 * OBX NM → numeric biomarker findings (primary clinical reasoning input)
 * OBX FT → narrative pathology comments (supporting context)
 *
 * OBX field mapping (HL7 v2.3.1):
 *   OBX-2  value type      (NM / FT)
 *   OBX-3  observation id  code^display^codingsystem
 *   OBX-5  observation value
 *   OBX-6  units           code^display^codingsystem
 *   OBX-7  reference range
 *   OBX-8  abnormal flag   (H / L / HH / LL / N / '' = not flagged)
 *   OBX-11 result status   (F = Final, P = Preliminary, C = Correction)
 */

import { parseHL7Message, field, comp, type HL7Segment } from './hl7-parser';

export interface BiomarkerFinding {
  /** NutriPath local code from OBX-3.1, e.g. 'BENZOIC_ACID_URINE_S'. */
  code: string;
  /** Display name from OBX-3.2 (falls back to code if absent). */
  name: string;
  /** Observation value from OBX-5. */
  value: string;
  /** Unit string from OBX-6.1. */
  unit: string;
  /** Reference range string from OBX-7, e.g. '0.00-0.30'. */
  reference_range: string;
  /** Abnormal flag from OBX-8 (H / L / HH / LL / N / '' = not flagged). */
  abnormal_flag: string;
  /** Observation result status from OBX-11 (F = Final, P = Preliminary). */
  result_status: string;
  /** Value type from OBX-2 (NM or FT). */
  observation_type: string;
}

export interface ParsedHL7Message {
  /** PID-3.1 — patient ID in the lab system. */
  patient_id: string;
  /** PID-7 — date of birth (YYYYMMDD as received from HL7). */
  patient_dob: string;
  /** PID-8 — administrative sex (M / F / U / O). */
  patient_sex: string;
  /** OBR-3.1 — filler order number (lab's message/order ID). */
  order_id: string;
  /** OBR-7 — observation date/time (YYYYMMDDHHMMSS from HL7). */
  collection_datetime: string;
  /** OBX rows with value type NM — primary numeric biomarker results. */
  numeric_findings: BiomarkerFinding[];
  /** OBX rows with value type FT — pathology narrative comments. */
  narrative_comments: BiomarkerFinding[];
}

function extractObx(seg: HL7Segment): BiomarkerFinding {
  const code = comp(seg, 3, 0);
  const displayName = comp(seg, 3, 1);
  return {
    code,
    name: displayName || code,
    value: field(seg, 5).raw,
    unit: comp(seg, 6, 0),
    reference_range: field(seg, 7).raw,
    abnormal_flag: field(seg, 8).raw,
    result_status: field(seg, 11).raw,
    observation_type: field(seg, 2).raw,
  };
}

export function adaptHL7Message(raw: string): ParsedHL7Message {
  const segments = parseHL7Message(raw);

  let patient_id = '';
  let patient_dob = '';
  let patient_sex = '';
  let order_id = '';
  let collection_datetime = '';
  const numeric_findings: BiomarkerFinding[] = [];
  const narrative_comments: BiomarkerFinding[] = [];

  for (const seg of segments) {
    switch (seg.name) {
      case 'PID':
        patient_id = comp(seg, 3, 0);
        patient_dob = field(seg, 7).raw;
        patient_sex = field(seg, 8).raw;
        break;
      case 'OBR':
        order_id = comp(seg, 3, 0);
        collection_datetime = field(seg, 7).raw;
        break;
      case 'OBX': {
        const valueType = field(seg, 2).raw;
        const finding = extractObx(seg);
        if (valueType === 'NM') {
          numeric_findings.push(finding);
        } else if (valueType === 'FT') {
          narrative_comments.push(finding);
        }
        break;
      }
    }
  }

  return {
    patient_id,
    patient_dob,
    patient_sex,
    order_id,
    collection_datetime,
    numeric_findings,
    narrative_comments,
  };
}
