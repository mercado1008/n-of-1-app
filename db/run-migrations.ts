/**
 * db/run-migrations.ts
 *
 * Minimal ordered SQL migration runner for the compounding justification
 * database (SQLite via better-sqlite3).
 *
 * Usage:
 *   npx tsx db/run-migrations.ts
 *
 * Environment:
 *   DB_PATH — path to the SQLite file (default: ./data/compounding.db)
 *
 * Behaviour:
 *   1. Opens (or creates) the database at DB_PATH.
 *   2. Creates the schema_version table if absent.
 *   3. Reads all *.sql files in db/migrations/ whose names match
 *      /^\d{3}_.*\.sql$/, sorted lexicographically (which is also
 *      numerically ascending for three-digit prefixes).
 *   4. Skips files whose version number is already recorded in schema_version.
 *   5. Executes each unapplied file in a single transaction.
 *   6. Records the applied version on success.
 *   7. Exits 1 on any error (the failed migration is NOT recorded).
 *
 * Design:
 *   - No ORM. Each migration is raw SQL that SQLite executes directly.
 *   - Each migration file runs in its own transaction. A partial apply is
 *     not recorded and will be retried on the next run.
 *   - Migration files are immutable once applied. Do not edit an applied
 *     file; add a new migration instead.
 *
 * schema_version columns:
 *   version     INTEGER  Three-digit prefix parsed from the filename.
 *   filename    TEXT     Full filename for auditability.
 *   applied_at  TEXT     ISO-8601 UTC timestamp set by this runner.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const DB_PATH        = process.env.DB_PATH ?? join(process.cwd(), 'data', 'compounding.db');
const MIGRATIONS_DIR = join(__dirname, 'migrations');

// ---------------------------------------------------------------------------
// Open database (create parent directory if absent)
// ---------------------------------------------------------------------------

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

// WAL mode for concurrent reads; foreign keys required by the schema.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// schema_version table
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    filename    TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL
  )
`);

const insertVersion = db.prepare(
  'INSERT INTO schema_version (version, filename, applied_at) VALUES (?, ?, ?)',
);

// ---------------------------------------------------------------------------
// Collect applied versions
// ---------------------------------------------------------------------------

interface VersionRow { version: number }
const applied = new Set(
  (db.prepare('SELECT version FROM schema_version').all() as VersionRow[]).map(
    (r) => r.version,
  ),
);

// ---------------------------------------------------------------------------
// Discover and apply migrations
// ---------------------------------------------------------------------------

const MIGRATION_FILE_RE = /^(\d{3})_.*\.sql$/;

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => MIGRATION_FILE_RE.test(f))
  .sort();                                  // lexicographic == numeric for 3-digit prefix

if (files.length === 0) {
  console.log('No migration files found in', MIGRATIONS_DIR);
  db.close();
  process.exit(0);
}

let appliedCount = 0;

for (const file of files) {
  const match = MIGRATION_FILE_RE.exec(file)!;
  const version = parseInt(match[1], 10);

  if (applied.has(version)) {
    console.log(`[skip] ${file}`);
    continue;
  }

  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

  // Wrap in an explicit transaction so a partial apply is not recorded.
  const applyMigration = db.transaction(() => {
    db.exec(sql);
    insertVersion.run(version, file, new Date().toISOString());
  });

  try {
    applyMigration();
    console.log(`[ok]   ${file}`);
    appliedCount++;
  } catch (err) {
    console.error(`[fail] ${file}`);
    console.error(err instanceof Error ? err.message : err);
    db.close();
    process.exit(1);
  }
}

if (appliedCount === 0) {
  console.log('All migrations already applied — nothing to do.');
} else {
  console.log(`Done. Applied ${appliedCount} migration(s).`);
}

db.close();
