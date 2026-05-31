import { listSubmissions } from "@/lib/submissions";
import Link from "next/link";

export default async function SubmissionsPage() {
  const submissions = await listSubmissions();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold text-forest">Submission history</h1>
        <Link href="/" className="text-sm bg-forest text-white px-4 py-2 rounded hover:bg-forest/90 transition-colors">
          + New submission
        </Link>
      </div>

      {submissions.length === 0 ? (
        <div className="text-center py-16 text-forest/40">
          <p className="text-lg mb-2">No submissions yet</p>
          <Link href="/" className="text-sm text-gold hover:text-forest">
            Submit your first analysis →
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded border border-sage/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cloud text-forest text-xs uppercase tracking-wider">
                <th className="text-left px-4 py-3">Patient</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Test</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Panel</th>
                <th className="text-right px-4 py-3">Fill</th>
                <th className="text-left px-4 py-3 hidden sm:table-cell">Date</th>
                <th className="text-left px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((s, i) => (
                <tr
                  key={s.id}
                  className={`border-t border-cloud hover:bg-cloud/50 transition-colors ${i % 2 === 0 ? "bg-white" : "bg-cloud/20"}`}
                >
                  <td className="px-4 py-3">
                    <Link href={`/submissions/${s.id}`} className="font-medium text-forest hover:text-gold transition-colors">
                      {s.patient_pseudonym}
                    </Link>
                    <div className="text-xs text-forest/50">{s.id}</div>
                  </td>
                  <td className="px-4 py-3 text-forest/70 hidden sm:table-cell">
                    {s.test_type.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {s.panel_classes.map(c => (
                      <span key={c} className="inline-block bg-sage/30 text-forest text-xs px-1.5 py-0.5 rounded mr-1">
                        {c}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.output_type === "formulation" ? (
                      <span className="font-mono text-sm text-forest">{s.pod_fill_pct}%</span>
                    ) : (
                      <span className="text-forest/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-forest/60 text-xs hidden sm:table-cell">
                    {new Date(s.submitted_at).toLocaleDateString("en-AU")}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      s.output_type === "formulation"
                        ? "bg-sage/40 text-forest"
                        : "bg-red-100 text-red-700"
                    }`}>
                      {s.output_type === "formulation" ? `${s.ingredient_count} ing` : "Refusal"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
