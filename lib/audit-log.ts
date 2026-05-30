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
