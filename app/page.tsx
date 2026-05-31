import SubmissionForm from "@/src/components/SubmissionForm";

export default function Home() {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-forest">New Submission</h1>
        <p className="text-sm text-forest/60 mt-1">
          Submit a functional pathology report for precision formulation analysis.
        </p>
      </div>
      <SubmissionForm />
    </div>
  );
}
