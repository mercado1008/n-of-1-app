"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

const PRACTITIONER_TYPES = [
  { value: "naturopath", label: "Naturopath" },
  { value: "nutritionist", label: "Nutritionist" },
  { value: "herbalist", label: "Herbalist" },
  { value: "gp", label: "GP" },
  { value: "nurse_practitioner", label: "Nurse Practitioner" },
  { value: "chinese_medicine", label: "Chinese Medicine" },
];

const TEST_TYPES = [
  { value: "Organic_Acids", label: "Organic Acids (OAT)" },
  { value: "EndoSCAN", label: "EndoSCAN (24h Hormones)" },
  { value: "NutriSTAT", label: "NutriSTAT" },
  { value: "Advanced_Thyroid", label: "Advanced Thyroid" },
  { value: "Cardiovascular_Risk", label: "Cardiovascular Risk" },
  { value: "Comprehensive_Stool_Analysis", label: "Comprehensive Stool Analysis" },
  { value: "Food_Intolerance", label: "Food Intolerance" },
  { value: "myDNA_Longevity", label: "myDNA Longevity" },
];

const PANEL_CLASSES = [
  { value: "FBP", label: "FBP — Functional Biomarker Panel" },
  { value: "HMP", label: "HMP — Hormone Metabolism Panel" },
  { value: "GP", label: "GP — Genomic Panel" },
  { value: "MP", label: "MP — Microbiome Panel" },
  { value: "TP", label: "TP — Toxicant Panel" },
  { value: "RIP", label: "RIP — Reactive/Immune Panel" },
];

function genSubmissionId() {
  const now = new Date();
  const year = now.getFullYear();
  const suffix = Math.floor(Math.random() * 900) + 100;
  return `SUB-${year}-${suffix}`;
}

export default function SubmissionForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [inputType, setInputType] = useState<"pdf" | "hl7">("pdf");
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
    test_type: "Organic_Acids",
    test_lab_id: "",
    test_collection_date: "",
    panel_classes: ["FBP"] as string[],
    clinical_notes: "",
  });

  const [hl7Text, setHl7Text] = useState("");

  function setField(key: string, value: string) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function togglePanelClass(cls: string) {
    setForm(f => ({
      ...f,
      panel_classes: f.panel_classes.includes(cls)
        ? f.panel_classes.filter(c => c !== cls)
        : [...f.panel_classes, cls],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (form.panel_classes.length === 0) {
      setError("Select at least one panel class.");
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
      test_type: form.test_type,
      test_lab_id: form.test_lab_id,
      test_collection_date: form.test_collection_date,
      panel_classes: form.panel_classes,
    };

    const fd = new FormData();
    fd.append("metadata", JSON.stringify(metadata));
    if (form.clinical_notes) fd.append("clinical_notes", form.clinical_notes);

    let url: string;
    if (inputType === "pdf") {
      const file = fileRef.current?.files?.[0];
      if (!file) { setError("Please select a PDF file."); return; }
      fd.append("pdf", file);
      url = "/api/analyse";
    } else {
      if (!hl7Text.trim()) { setError("Please paste the HL7 message."); return; }
      fd.append("hl7", hl7Text);
      url = "/api/analyse-hl7";
    }

    setLoading(true);
    try {
      const res = await fetch(url, { method: "POST", body: fd });
      const body = await res.json();
      if (!body.ok) {
        setError(body.error?.message ?? "Analysis failed.");
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
      {/* Input type toggle */}
      <div>
        <label className="block text-sm font-medium text-forest mb-2">Input format</label>
        <div className="flex gap-3">
          {(["pdf", "hl7"] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setInputType(t)}
              className={`px-4 py-2 rounded text-sm font-medium border transition-colors ${
                inputType === t
                  ? "bg-forest text-white border-forest"
                  : "bg-white text-forest border-sage hover:border-forest"
              }`}
            >
              {t === "pdf" ? "PDF upload" : "HL7 text"}
            </button>
          ))}
        </div>
      </div>

      {/* File / HL7 input */}
      {inputType === "pdf" ? (
        <div>
          <label className="block text-sm font-medium text-forest mb-1">
            Pathology PDF <span className="text-red-500">*</span>
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            required
            className="block w-full text-sm text-forest file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:bg-gold/20 file:text-forest hover:file:bg-gold/40 cursor-pointer"
          />
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-forest mb-1">
            HL7 v2.3.1 message <span className="text-red-500">*</span>
          </label>
          <textarea
            value={hl7Text}
            onChange={e => setHl7Text(e.target.value)}
            rows={8}
            placeholder="MSH|^~\&|..."
            className="w-full font-mono text-xs border border-sage rounded p-3 focus:outline-none focus:border-forest"
          />
        </div>
      )}

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
            onChange={e => setField("practitioner_id", e.target.value)}
            required
            className={inputCls}
          />
        </Field>

        <Field label="Practitioner type" required>
          <select
            value={form.practitioner_type}
            onChange={e => setField("practitioner_type", e.target.value)}
            className={inputCls}
          >
            {PRACTITIONER_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Practitioner name (optional)">
          <input
            value={form.practitioner_name}
            onChange={e => setField("practitioner_name", e.target.value)}
            className={inputCls}
            placeholder="Optional"
          />
        </Field>

        <Field label="Patient pseudonym" required>
          <input
            value={form.patient_pseudonym}
            onChange={e => setField("patient_pseudonym", e.target.value)}
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
            onChange={e => setField("patient_age_years", e.target.value)}
            required
            className={inputCls}
          />
        </Field>

        <Field label="Sex assigned at birth" required>
          <select
            value={form.patient_sex_assigned_at_birth}
            onChange={e => setField("patient_sex_assigned_at_birth", e.target.value)}
            className={inputCls}
          >
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="intersex">Intersex</option>
            <option value="unspecified">Unspecified</option>
          </select>
        </Field>

        <Field label="Test type" required>
          <select
            value={form.test_type}
            onChange={e => setField("test_type", e.target.value)}
            className={inputCls}
          >
            {TEST_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Lab / order ID" required>
          <input
            value={form.test_lab_id}
            onChange={e => setField("test_lab_id", e.target.value)}
            required
            placeholder="e.g. 6463011"
            className={inputCls}
          />
        </Field>

        <Field label="Collection date" required>
          <input
            type="date"
            value={form.test_collection_date}
            onChange={e => setField("test_collection_date", e.target.value)}
            required
            className={inputCls}
          />
        </Field>
      </div>

      {/* Panel classes */}
      <div>
        <label className="block text-sm font-medium text-forest mb-2">
          Panel classes <span className="text-red-500">*</span>
        </label>
        <div className="flex flex-wrap gap-3">
          {PANEL_CLASSES.map(cls => (
            <label key={cls.value} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.panel_classes.includes(cls.value)}
                onChange={() => togglePanelClass(cls.value)}
                className="accent-forest"
              />
              <span className="text-sm text-forest">{cls.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Clinical notes */}
      <Field label="Practitioner clinical notes (optional)">
        <textarea
          value={form.clinical_notes}
          onChange={e => setField("clinical_notes", e.target.value)}
          rows={4}
          maxLength={10000}
          placeholder="Any relevant clinical context, medications, contraindications, or prior formulation history..."
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
