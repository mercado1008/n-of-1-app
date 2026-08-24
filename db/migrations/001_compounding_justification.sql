-- N of 1 — Compounding justification records
-- SQLite dialect (better-sqlite3). Translated from
-- src/lib/compounding/justification-schema.sql (PostgreSQL).
--
-- Key translation decisions:
--
--   Postgres                              SQLite
--   ────────────────────────────────────  ──────────────────────────────────────────
--   CREATE TYPE ... AS ENUM (...)     →   TEXT CHECK (col IN (...)) inline on column
--   BIGSERIAL PRIMARY KEY             →   INTEGER PRIMARY KEY AUTOINCREMENT
--   TIMESTAMPTZ NOT NULL DEFAULT now()→   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
--   TIMESTAMPTZ (nullable)            →   TEXT
--   JSONB NOT NULL                    →   TEXT NOT NULL CHECK (json_valid(col))
--   NUMERIC(6,4)                      →   REAL
--   BOOLEAN                           →   INTEGER (0 = false, 1 = true)
--   BIGINT REFERENCES ...             →   INTEGER REFERENCES ...
--   CREATE RULE ... DO INSTEAD NOTHING→   BEFORE DELETE trigger with RAISE(ABORT)
--   Partial index WHERE clause        →   supported as written in SQLite ≥ 3.8.9
--
-- DELIVERY_SYSTEM is added to the justification_code values here; it was
-- absent from the original schema which predates the evaluator.
--
-- Run with the migration runner (db/run-migrations.ts), which wraps each
-- file in a transaction and records the applied version in schema_version.
--
-- Enable foreign keys before any DML:
--   PRAGMA foreign_keys = ON;

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- ARTG snapshot registry
-- ---------------------------------------------------------------------------
-- Dated snapshot of the ARTG reference set the engine evaluated against.
-- Assessments reference a snapshot by id; the snapshot is immutable once
-- stored so assessments can be re-derived.

CREATE TABLE IF NOT EXISTS artg_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT    NOT NULL UNIQUE,   -- ISO-8601 date, e.g. '2026-08-12'
  source        TEXT    NOT NULL,          -- 'visualisation_tool_export' | 'ingest_worker'
  record_count  INTEGER NOT NULL,
  created_at    TEXT    NOT NULL
                DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Justification assessment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS justification_assessment (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id               TEXT    NOT NULL,
  practitioner_id        TEXT    NOT NULL,
  patient_ref            TEXT    NOT NULL,

  status                 TEXT    NOT NULL
                           CHECK (status IN ('JUSTIFIED', 'REVIEW_REQUIRED')),

  artg_snapshot_id       INTEGER NOT NULL
                           REFERENCES artg_snapshot(id),

  -- Frozen inputs. Retained so the assessment can be re-derived and audited.
  draft_snapshot         TEXT    NOT NULL CHECK (json_valid(draft_snapshot)),
  candidates_considered  TEXT    NOT NULL CHECK (json_valid(candidates_considered)),

  -- Guideline 1.1.1(b) close-formulation test result.
  closest_artg_id        TEXT,
  moiety_overlap         REAL,
  dose_agreement         REAL,
  is_close_formulation   INTEGER,         -- 0 | 1

  evaluated_at           TEXT    NOT NULL
                           DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Practitioner confirmation. The engine computes; the practitioner confirms.
  confirmed_by           TEXT,
  confirmed_at           TEXT,

  -- Pharmacist sign-off. Required before the formulation can be dispensed.
  -- REVIEW_REQUIRED assessments cannot be system-resolved; a pharmacist must
  -- either decline or record their own determination here.
  pharmacist_id          TEXT,
  pharmacist_decision    TEXT CHECK (pharmacist_decision IN ('PROCEED', 'DECLINE')),
  pharmacist_note        TEXT,
  pharmacist_decided_at  TEXT,

  -- Enforce that a REVIEW_REQUIRED assessment may not be marked confirmed
  -- without a pharmacist decision already recorded.
  CONSTRAINT review_requires_pharmacist CHECK (
    status <> 'REVIEW_REQUIRED'
    OR pharmacist_decision IS NOT NULL
    OR confirmed_at IS NULL
  )
);

-- ---------------------------------------------------------------------------
-- Justification reason
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS justification_reason (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id  INTEGER NOT NULL
                   REFERENCES justification_assessment(id) ON DELETE CASCADE,

  -- DELIVERY_SYSTEM added in Aug 2026; original schema omitted it.
  code           TEXT    NOT NULL
                   CHECK (code IN (
                     'DOSE_FORM',
                     'DOSE_OUTSIDE_AVAILABLE_STRENGTHS',
                     'COMBINATION_REQUIRED',
                     'INGREDIENT_EXCLUSION',
                     'DELIVERY_SYSTEM'
                   )),

  guideline_ref  TEXT    NOT NULL,

  -- Machine-generated arithmetic supporting the determination.
  evidence       TEXT    NOT NULL CHECK (json_valid(evidence)),

  determined_by  TEXT    NOT NULL DEFAULT 'SYSTEM'
                   CHECK (determined_by IN ('SYSTEM', 'PHARMACIST')),

  UNIQUE (assessment_id, code)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_assessment_draft
  ON justification_assessment (draft_id);

CREATE INDEX IF NOT EXISTS idx_assessment_practitioner
  ON justification_assessment (practitioner_id, evaluated_at DESC);

-- Partial index: only unresolved REVIEW_REQUIRED rows — the working queue
-- the pharmacist operates from. Once decided, the row falls out of scope.
CREATE INDEX IF NOT EXISTS idx_assessment_pending_review
  ON justification_assessment (status)
  WHERE status = 'REVIEW_REQUIRED';

-- ---------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------
-- Assessments must never be deleted. A superseded draft triggers a new
-- assessment row; prior rows are the immutable audit trail.
-- RAISE(ABORT) surfaces the violation as an error, consistent with the
-- intent of the Postgres CREATE RULE ... DO INSTEAD NOTHING (which silently
-- blocked deletes). We prefer a hard error here: silent prevention masks
-- logic bugs in callers.

CREATE TRIGGER IF NOT EXISTS justification_assessment_no_delete
BEFORE DELETE ON justification_assessment
BEGIN
  SELECT RAISE(
    ABORT,
    'justification_assessment rows are append-only; delete is not permitted'
  );
END;
