import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AuditBlock } from './build-prompt';

export interface AuditLogEntry {
  audit_reference: string;
  audit: AuditBlock;
  outcome: {
    output_type: string;
    granules_computed?: number;
    pod_budget_used?: number;
    ingredient_count?: number;
    stop_reason?: string | null;
    /** Overfill retry backstop (see lib/underfill-retry.ts) — omitted when ceiling wasn't breached. */
    overfill_retry_attempted?: boolean;
    overfill_retry_outcome?: 'succeeded' | 'still_overfilled' | 'retry_failed';
    /** Underfill retry backstop (see lib/underfill-retry.ts) — omitted when the floor didn't apply. */
    underfill_retry_attempted?: boolean;
    underfill_retry_outcome?: 'succeeded' | 'still_underfilled' | 'retry_failed';
    pre_retry_granules_computed?: number;
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');

export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
}
