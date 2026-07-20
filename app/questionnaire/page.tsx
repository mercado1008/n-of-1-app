import QuestionnaireForm from "@/src/components/QuestionnaireForm";

export default function QuestionnairePage() {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-forest">New Submission — Questionnaire Only</h1>
        <p className="text-sm text-forest/60 mt-1">
          No pathology test attached. Submit a structured symptom questionnaire for precision formulation analysis.
        </p>
      </div>
      <QuestionnaireForm />
    </div>
  );
}
