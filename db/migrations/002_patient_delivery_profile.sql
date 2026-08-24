-- N of 1 — Patient delivery profile
--
-- Stores per-patient delivery-system constraints used by the DELIVERY_SYSTEM
-- justification evaluator.  Lives on the patient record, not the formulation —
-- constraints are demographic/clinical, not prescription-specific.
--
-- One row per patient (UNIQUE patient_ref). The record is editable: set at
-- intake, updated when the practitioner's assessment changes. All edits are
-- tracked via updated_by / updated_at; for a full audit trail, wrap updates
-- in an application-level change-log table (out of scope here).
--
-- SQLite dialect (better-sqlite3).  Key differences from the Postgres schema
-- in justification-schema.sql:
--
--   Postgres                          SQLite
--   ─────────────────────────────     ──────────────────────────────────────
--   BOOLEAN                     →     INTEGER CHECK (val IN (0, 1))
--   TIMESTAMPTZ                 →     TEXT  (ISO-8601, stored by application)
--   BIGSERIAL PRIMARY KEY       →     INTEGER PRIMARY KEY AUTOINCREMENT
--   ENUM ('A','B')              →     TEXT  CHECK (col IN ('A', 'B'))
--
-- Run with: better-sqlite3 .db exec fs.readFileSync('db/migrations/001_patient_delivery_profile.sql','utf8')
-- or via the migration runner (to be wired in a future task).
--
-- Enable foreign-key enforcement before any DML:
--   PRAGMA foreign_keys = ON;

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patient_delivery_profile (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- One profile per patient.
  patient_ref           TEXT    NOT NULL UNIQUE,

  -- The three delivery-system constraint booleans.
  -- Stored as INTEGER 0/1; application layer maps to boolean.
  swallowing_difficulty INTEGER NOT NULL DEFAULT 0
                          CHECK (swallowing_difficulty IN (0, 1)),
  high_pill_burden      INTEGER NOT NULL DEFAULT 0
                          CHECK (high_pill_burden IN (0, 1)),
  requires_powder       INTEGER NOT NULL DEFAULT 0
                          CHECK (requires_powder IN (0, 1)),

  -- Provenance — who recorded this and when.
  recorded_by           TEXT    NOT NULL,
  recorded_at           TEXT    NOT NULL,   -- ISO-8601, e.g. '2026-08-12T09:00:00Z'

  -- Populated on edit; null on the initial insert.
  updated_by            TEXT,
  updated_at            TEXT                -- ISO-8601
);

-- Fast lookup by patientRef at assessment time.
CREATE INDEX IF NOT EXISTS idx_delivery_profile_patient
  ON patient_delivery_profile (patient_ref);
