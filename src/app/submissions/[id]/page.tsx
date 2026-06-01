import { getSubmission, hasDocuments } from "@/lib/submissions";
import { notFound } from "next/navigation";
import Link from "next/link";

const s = (v: unknown): string => (v == null ? "" : String(v));

export default async function ResultsPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [sub, docsAvailable] = await Promise.all([
    getSubmission(id),
    hasDocuments(id),
  ]);
  if (!sub) notFound();

  const { request, response } = sub;
  const output = response.output as Record<string, unknown>;
  const gv = response.granule_verification;
  const isFormulation = output.output_type === "formulation";
  const fillPct = (gv.pod_budget_used * 100).toFixed(1);

  const patterns = (output.recognised_patterns as { pattern_name: string; supporting_findings?: string[] }[] | undefined) ?? [];
  const ingredients = (output.proposed_formulation as Record<string, unknown>[] | undefined) ?? [];
  const bindings = (output.binding_exclusions_applied as { ingredient_name: string; panel_finding_that_triggered: string }[] | undefined) ?? [];
  const standalones = (output.standalone_recommendations as { recommendation: string }[] | undefined) ?? [];
  const flags = (output.contraindication_flags as { flag: string; severity?: string }[] | undefined) ?? [];
  const references = (output.references as { ingredient_name: string; citation: string }[] | undefined) ?? [];
  const executive = output.executive_summary as Record<string, unknown> | undefined;

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold text-forest">{request.patient_pseudonym}</h1>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${isFormulation ? "bg-sage/40 text-forest" : "bg-red-100 text-red-700"}`}>
              {isFormulation ? "Formulation" : "Refusal"}
            </span>
          </div>
          <p className="text-sm text-forest/60">
            {request.test_type} · {request.test_collection_date} · {request.submission_id}
          </p>
        </div>
        <Link href="/submissions" className="text-sm text-gold hover:text-forest transition-colors">
          ← History
        </Link>
      </div>

      {/* Download links */}
      {docsAvailable && isFormulation && (
        <div className="flex gap-3">
          <a
            href={`/api/submissions/${id}/documents/health-analysis`}
            className="flex items-center gap-2 px-4 py-2 bg-forest text-white text-sm rounded hover:bg-forest/90 transition-colors"
            download
          >
            ↓ Health Analysis (.docx)
          </a>
          <a
            href={`/api/submissions/${id}/documents/formulation-schedule`}
            className="flex items-center gap-2 px-4 py-2 bg-gold/80 text-forest text-sm rounded hover:bg-gold transition-colors"
            download
          >
            ↓ Formulation Schedule (.xlsx)
          </a>
        </div>
      )}

      {/* Headline */}
      {executive?.headline != null && (
        <div className="bg-white rounded border border-sage/50 p-4">
          <p className="text-sm text-forest leading-relaxed">{s(executive.headline)}</p>
        </div>
      )}

      {isFormulation && (
        <>
          {/* Pod fill */}
          <div className="bg-white rounded border border-sage/50 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-forest">Pod fill</span>
              <span className="text-sm font-mono text-forest">
                {gv.computed_total_granules} / 710 granules ({fillPct}%)
              </span>
            </div>
            <div className="h-2 bg-cloud rounded-full overflow-hidden">
              <div
                className="h-full bg-gold rounded-full"
                style={{ width: `${Math.min(parseFloat(fillPct), 100)}%` }}
              />
            </div>
            <p className="text-xs text-forest/50 mt-1">{(gv.computed_total_pod_weight_mg / 1000).toFixed(2)} g pod weight</p>
          </div>

          {/* Patterns */}
          {patterns.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-forest uppercase tracking-wider mb-3">
                Recognised patterns ({patterns.length})
              </h2>
              <ul className="space-y-2">
                {patterns.map((p, i) => (
                  <li key={i} className="bg-white rounded border border-sage/50 p-3">
                    <p className="text-sm font-medium text-forest">{p.pattern_name}</p>
                    {p.supporting_findings && (
                      <p className="text-xs text-forest/60 mt-1">
                        {p.supporting_findings.slice(0, 3).join(" · ")}
                        {p.supporting_findings.length > 3 && ` · +${p.supporting_findings.length - 3} more`}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Ingredients */}
          {ingredients.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-forest uppercase tracking-wider mb-3">
                Formulation ({ingredients.length} ingredients)
              </h2>
              <div className="bg-white rounded border border-sage/50 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-cloud text-forest text-xs uppercase tracking-wider">
                      <th className="text-left px-3 py-2">Ingredient</th>
                      <th className="text-left px-3 py-2">Dose</th>
                      <th className="text-right px-3 py-2">Granules</th>
                      <th className="text-left px-3 py-2 hidden sm:table-cell">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ingredients.map((ing, i) => {
                      const routeGranules = (gv.computed_per_ingredient as Record<string, unknown>[]).find(
                        (c) => c.tsi_code === ing.tsi_code
                      );
                      return (
                        <tr key={i} className={`border-t border-cloud ${i % 2 === 0 ? "bg-white" : "bg-cloud/30"}`}>
                          <td className="px-3 py-2">
                            <div className="font-medium text-forest">{s(ing.common_name)}</div>
                            <div className="text-xs text-forest/50">{s(ing.tsi_code)}</div>
                          </td>
                          <td className="px-3 py-2 text-forest">
                            {s(ing.proposed_dose)} {s(ing.dose_unit)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-forest">
                            {routeGranules ? s(routeGranules.computed_granules) : "—"}
                          </td>
                          <td className="px-3 py-2 text-forest/60 text-xs hidden sm:table-cell">
                            {s(ing.category).replace(/_/g, " ")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Binding exclusions */}
          {bindings.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-forest uppercase tracking-wider mb-3">
                Binding exclusions ({bindings.length})
              </h2>
              <ul className="space-y-2">
                {bindings.map((b, i) => (
                  <li key={i} className="bg-red-50 border border-red-200 rounded p-3">
                    <p className="text-sm font-medium text-red-800">{b.ingredient_name}</p>
                    <p className="text-xs text-red-600 mt-0.5">{b.panel_finding_that_triggered}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Standalones */}
          {standalones.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-forest uppercase tracking-wider mb-3">
                Standalone recommendations ({standalones.length})
              </h2>
              <ul className="space-y-1">
                {standalones.map((s, i) => (
                  <li key={i} className="flex gap-2 text-sm text-forest">
                    <span className="text-gold mt-0.5">·</span>
                    {s.recommendation}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Contraindication flags */}
          {flags.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-forest uppercase tracking-wider mb-3">
                Contraindication flags ({flags.length})
              </h2>
              <ul className="space-y-1">
                {flags.map((f, i) => (
                  <li key={i} className="text-sm text-forest/80">
                    <span className="text-gold mr-1">·</span>{f.flag}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* References */}
          {references.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-forest uppercase tracking-wider mb-3">
                References ({references.length})
              </h2>
              <ol className="space-y-1.5 list-none">
                {references.map((r, i) => (
                  <li key={i} className="flex gap-2 text-xs text-forest/70">
                    <span className="text-gold font-bold shrink-0">[{i + 1}]</span>
                    <span>{r.citation} <em className="text-forest/50">({r.ingredient_name})</em></span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}

      {/* Refusal */}
      {!isFormulation && (
        <div className="bg-red-50 border border-red-200 rounded p-4">
          <p className="text-sm font-medium text-red-800 mb-1">
            Refusal trigger: {s(output.refusal_trigger)}
          </p>
          <p className="text-sm text-red-700">{s(output.refusal_explanation)}</p>
        </div>
      )}

      {/* Audit footer */}
      <div className="text-xs text-forest/40 border-t border-sage/30 pt-4">
        {response.audit.system_prompt_version} · schema {response.audit.output_schema_version} · library rev {response.audit.library_revision} · {new Date(response.audit.generated_at_iso).toLocaleString("en-AU")}
      </div>
    </div>
  );
}
