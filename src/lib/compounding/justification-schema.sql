-- N of 1 — Compounding justification records
--
-- Justifications are evaluated against a dated ARTG snapshot. Commercial
-- availability changes; a justification that was true in August may be false in
-- November. The record must therefore freeze both the snapshot reference and the
-- evidence payload at the moment of assessment, and must never be recomputed
-- in place.

CREATE TYPE justification_code AS ENUM (
  'DOSE_FORM',
  'DOSE_OUTSIDE_AVAILABLE_STRENGTHS',
  'COMBINATION_REQUIRED',
  'INGREDIENT_EXCLUSION'
);

CREATE TYPE justification_status AS ENUM ('JUSTIFIED', 'REVIEW_REQUIRED');

-- Dated snapshot of the ARTG reference set the engine evaluated against.
CREATE TABLE artg_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_date   DATE        NOT NULL UNIQUE,
  source          TEXT        NOT NULL, -- 'visualisation_tool_export' | 'ingest_worker'
  record_count    INTEGER     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE justification_assessment (
  id                     BIGSERIAL PRIMARY KEY,
  draft_id               TEXT                NOT NULL,
  practitioner_id        TEXT                NOT NULL,
  patient_ref            TEXT                NOT NULL,
  status                 justification_status NOT NULL,
  artg_snapshot_id       BIGINT              NOT NULL REFERENCES artg_snapshot(id),

  -- Frozen inputs. Retained so the assessment can be re-derived and checked.
  draft_snapshot         JSONB               NOT NULL,
  candidates_considered  JSONB               NOT NULL,

  -- Guideline 1.1.1(b) close-formulation test result.
  closest_artg_id        TEXT,
  moiety_overlap         NUMERIC(6,4),
  dose_agreement         NUMERIC(6,4),
  is_close_formulation   BOOLEAN,

  evaluated_at           TIMESTAMPTZ         NOT NULL DEFAULT now(),

  -- Practitioner confirmation. The engine computes; the practitioner confirms.
  confirmed_by           TEXT,
  confirmed_at           TIMESTAMPTZ,

  -- Pharmacist sign-off. Required before the formulation can be dispensed.
  -- REVIEW_REQUIRED assessments cannot be system-resolved; a pharmacist must
  -- either decline or record their own determination here.
  pharmacist_id          TEXT,
  pharmacist_decision    TEXT CHECK (pharmacist_decision IN ('PROCEED', 'DECLINE')),
  pharmacist_note        TEXT,
  pharmacist_decided_at  TIMESTAMPTZ,

  CONSTRAINT review_requires_pharmacist CHECK (
    status <> 'REVIEW_REQUIRED'
    OR pharmacist_decision IS NOT NULL
    OR confirmed_at IS NULL
  )
);

CREATE TABLE justification_reason (
  id                BIGSERIAL PRIMARY KEY,
  assessment_id     BIGINT             NOT NULL
                      REFERENCES justification_assessment(id) ON DELETE CASCADE,
  code              justification_code NOT NULL,
  guideline_ref     TEXT               NOT NULL,
  -- Machine-generated arithmetic supporting the determination.
  evidence          JSONB              NOT NULL,
  determined_by     TEXT               NOT NULL DEFAULT 'SYSTEM'
                      CHECK (determined_by IN ('SYSTEM', 'PHARMACIST')),
  UNIQUE (assessment_id, code)
);

CREATE INDEX idx_assessment_draft ON justification_assessment (draft_id);
CREATE INDEX idx_assessment_practitioner ON justification_assessment (practitioner_id, evaluated_at DESC);
CREATE INDEX idx_assessment_status ON justification_assessment (status)
  WHERE status = 'REVIEW_REQUIRED';

-- Assessments are append-only. Superseding a draft creates a new assessment row;
-- prior rows are never mutated or deleted.
CREATE RULE justification_assessment_no_delete AS
  ON DELETE TO justification_assessment DO INSTEAD NOTHING;
