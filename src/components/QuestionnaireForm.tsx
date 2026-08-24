"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SymptomCategory, type Severity } from "@/lib/questionnaire-schema";

const PRACTITIONER_TYPES = [
  { value: "naturopath", label: "Naturopath" },
  { value: "nutritionist", label: "Nutritionist" },
  { value: "herbalist", label: "Herbalist" },
  { value: "gp", label: "GP" },
  { value: "nurse_practitioner", label: "Nurse Practitioner" },
  { value: "chinese_medicine", label: "Chinese Medicine" },
];

const SEVERITIES: { value: Severity; label: string }[] = [
  { value: "none", label: "None" },
  { value: "mild", label: "Mild" },
  { value: "moderate", label: "Moderate" },
  { value: "severe", label: "Severe" },
];

const CATEGORIES = SymptomCategory.options;

function genSubmissionId() {
  const now = new Date();
  const year = now.getFullYear();
  const suffix = Math.floor(Math.random() * 900) + 100;
  return `SUB-${year}-${suffix}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function QuestionnaireForm() {
  const router = useRouter();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissionId] = useState(genSubmissionId);

  const [form, setForm] = useState({
    practitioner_id: "P001-NATUROPATH",
    practitioner_type: "naturopath",
    practitioner_name: "",
    patient_pseudonym: "",
    patient_age_years: "",
    patient_sex_assigned_at_birth: "female",
    clinical_notes: "",
  });

  const [severities, setSeverities] = useState<Record<string, Severity>>(
    () => Object.fromEntries(CATEGORIES.map((c) => [c, "none" as Severity])),
  );

  const [safety, setSafety] = useState({
    pregnant_or_breastfeeding: false,
    active_malignancy_or_oncology_treatment: false,
    end_stage_organ_failure_or_dialysis: false,
    active_eating_disorder: false,
    active_suicidal_ideation_or_recent_attempt: false,
    known_kidney_disease: false,
    known_liver_disease: false,
    current_medications: "",
  });

  function setField(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function setSeverity(category: string, value: Severity) {
    setSeverities((s) => ({ ...s, [category]: value }));
  }

  function toggleSafety(key: keyof typeof safety) {
    setSafety((s) => ({ ...s, [key]: !s[key] }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const hasSymptomData = Object.values(severities).some((v) => v !== "none");
    if (!hasSymptomData && !form.clinical_notes.trim()) {
      setError("Rate at least one symptom category or add clinical notes — the questionnaire has no clinical content otherwise.");
      return;
    }

    const metadata = {
      submission_id: submissionId,
      practitioner_id: form.practitioner_id,
      practitioner_type: form.practitioner_type,
      ...(form.practitioner_name ? { practitioner_name: form.practitioner_name } : {}),
      patient_pseudonym: form.patient_pseudonym,
      patient_age_years: parseInt(form.patient_age_years, 10),
      patient_sex_assigned_at_birth: form.patient_sex_assigned_at_birth,
      test_type: "Practitioner_Symptom_Questionnaire",
      test_lab_id: "N/A — practitioner questionnaire",
      test_collection_date: todayIso(),
      panel_classes: ["SPP"],
    };

    const body = {
      metadata,
      clinical_notes: form.clinical_notes,
      questionnaire: {
        symptom_categories: severities,
        safety_screening: safety,
      },
    };

    setLoading(true);
    try {
      const res = await fetch("/api/analyse-questionnaire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const responseBody = await res.json();
      if (!responseBody.ok) {
        setError(responseBody.error?.message ?? "Analysis failed.");
        return;
      }
      router.push(`/submissions/${submissionId}`);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div className="bg-cloud/60 border border-sage rounded px-4 py-3 text-sm text-forest">
        No pathology test is attached to this submission — the symptom ratings and safety-screening answers below are the sole clinical input (SPP — Symptom Presentation Panel). Biomarker-dependent safety checks (e.g. selenium, copper) cannot run without lab data; the practitioner is relied on for the safety-screening answers instead.
      </div>

      {/* Two-column metadata */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Submission ID" required>
          <input
            value={submissionId}
            readOnly
            className="w-full border border-sage rounded px-3 py-2 text-sm bg-cloud text-forest/60"
          />
        </Field>

        <Field label="Practitioner ID" required>
          <input
            value={form.practitioner_id}
            onChange={(e) => setField("practitioner_id", e.target.value)}
            required
            className={inputCls}
          />
        </Field>

        <Field label="Practitioner type" required>
          <select
            value={form.practitioner_type}
            onChange={(e) => setField("practitioner_type", e.target.value)}
            className={inputCls}
          >
            {PRACTITIONER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Practitioner name (optional)">
          <input
            value={form.practitioner_name}
            onChange={(e) => setField("practitioner_name", e.target.value)}
            className={inputCls}
            placeholder="Optional"
          />
        </Field>

        <Field label="Patient pseudonym" required>
          <input
            value={form.patient_pseudonym}
            onChange={(e) => setField("patient_pseudonym", e.target.value)}
            required
            placeholder="PT-2026-XXX"
            className={inputCls}
          />
        </Field>

        <Field label="Patient age (years)" required>
          <input
            type="number"
            min={18}
            max={120}
            value={form.patient_age_years}
            onChange={(e) => setField("patient_age_years", e.target.value)}
            required
            className={inputCls}
          />
        </Field>

        <Field label="Sex assigned at birth" required>
          <select
            value={form.patient_sex_assigned_at_birth}
            onChange={(e) => setField("patient_sex_assigned_at_birth", e.target.value)}
            className={inputCls}
          >
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="intersex">Intersex</option>
            <option value="unspecified">Unspecified</option>
          </select>
        </Field>
      </div>

      {/* Symptom categories */}
      <div>
        <label className="block text-sm font-medium text-forest mb-2">
          Symptom categories <span className="text-red-500">*</span>
        </label>
        <p className="text-xs text-forest/60 mb-3">Rate each category as the patient currently presents. Categories left at &ldquo;None&rdquo; do not activate a therapeutic axis.</p>
        <div className="space-y-2">
          {CATEGORIES.map((category) => (
            <div key={category} className="flex items-center justify-between gap-4 border border-sage rounded px-3 py-2">
              <span className="text-sm text-forest">{category}</span>
              <div className="flex gap-1">
                {SEVERITIES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setSeverity(category, s.value)}
                    className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                      severities[category] === s.value
                        ? "bg-forest text-white border-forest"
                        : "bg-white text-forest border-sage hover:border-forest"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Safety screening */}
      <div>
        <label className="block text-sm font-medium text-forest mb-2">Safety screening</label>
        <p className="text-xs text-forest/60 mb-3">These stand in for the pathology-test-dependent safety checks that can&apos;t run without lab data.</p>
        <div className="space-y-2">
          {([
            ["pregnant_or_breastfeeding", "Pregnant or breastfeeding"],
            ["active_malignancy_or_oncology_treatment", "Active malignancy or oncology treatment"],
            ["end_stage_organ_failure_or_dialysis", "End-stage organ failure or on dialysis"],
            ["active_eating_disorder", "Active eating disorder"],
            ["active_suicidal_ideation_or_recent_attempt", "Active suicidal ideation or recent suicide attempt"],
            ["known_kidney_disease", "Known kidney disease"],
            ["known_liver_disease", "Known liver disease"],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={safety[key]}
                onChange={() => toggleSafety(key)}
                className="accent-forest"
              />
              <span className="text-sm text-forest">{label}</span>
            </label>
          ))}
        </div>
        <div className="mt-3">
          <Field label="Current medications (optional)">
            <textarea
              value={safety.current_medications}
              onChange={(e) => setSafety((s) => ({ ...s, current_medications: e.target.value }))}
              rows={2}
              placeholder="List any current medications, or leave blank if none"
              className={`${inputCls} resize-y`}
            />
          </Field>
        </div>
      </div>

      {/* Clinical notes */}
      <Field label="Practitioner clinical notes (optional)">
        <textarea
          value={form.clinical_notes}
          onChange={(e) => setField("clinical_notes", e.target.value)}
          rows={4}
          maxLength={10000}
          placeholder="Presenting concern, relevant history, or anything not captured above..."
          className={`${inputCls} resize-y`}
        />
      </Field>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded px-4 py-3 text-sm">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-forest text-white py-3 rounded font-medium hover:bg-forest/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            Analysing — this takes 4–5 minutes…
          </span>
        ) : (
          "Submit for analysis"
        )}
      </button>
    </form>
  );
}

const inputCls = "w-full border border-sage rounded px-3 py-2 text-sm focus:outline-none focus:border-forest bg-white";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-forest mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
