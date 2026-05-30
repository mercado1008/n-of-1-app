import { createHash } from 'node:crypto';
import type { AuditBlock } from './build-prompt';

/**
 * Compute the deterministic opaque Audit Reference from a route-side AuditBlock.
 *
 * Produces the same XXXX-XXXX-XXXX token that appears in practitioner-facing
 * documents. Keying the server-side audit log by this reference lets any
 * document reference be cross-checked against the server record for regulatory
 * inquiry.
 */
export function computeAuditReference(audit: AuditBlock): string {
  const inputs = [
    audit.submission_id,
    audit.system_prompt_version,
    audit.output_schema_version,
    String(audit.library_revision),
    audit.skill_version,
    audit.pdf_sha256,
  ].join('|');
  const hash = createHash('sha256').update(inputs).digest('hex');
  const hex = hash.slice(0, 12).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}
