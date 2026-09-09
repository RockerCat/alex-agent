import { supabaseAdmin } from "@/lib/supabase/admin";
import { QuestionAnswerForm } from "@/components/QuestionAnswerForm";

export const dynamic = "force-dynamic";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
      {children}
    </div>
  );
}

export default async function QuestionsPage() {
  const db = supabaseAdmin();

  const { data: openQuestions } = await db
    .from("agent_questions")
    .select("*")
    .eq("brand", "solardesk")
    .eq("status", "open")
    .order("created_at", { ascending: true });

  const { data: answeredQuestions } = await db
    .from("agent_questions")
    .select("*")
    .eq("brand", "solardesk")
    .eq("status", "answered")
    .order("answered_at", { ascending: false })
    .limit(10);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Questions</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Genuine business/product blockers AlexAgent could not resolve on its own.
        </p>
      </div>

      {(!openQuestions || openQuestions.length === 0) && (
        <div className="rounded-lg border p-6 text-sm text-center" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
          No open questions.
        </div>
      )}

      <div className="space-y-3">
        {openQuestions?.map((q) => (
          <Card key={q.id}>
            <p className="font-medium">{q.question}</p>
            <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              Why: {q.reason}
            </p>
            <div className="mt-3">
              <QuestionAnswerForm questionId={q.id} />
            </div>
          </Card>
        ))}
      </div>

      {answeredQuestions && answeredQuestions.length > 0 && (
        <div>
          <h2 className="font-medium mt-6 mb-2">Recently answered</h2>
          <ul className="space-y-2 text-sm">
            {answeredQuestions.map((q) => (
              <li key={q.id} className="rounded-md border p-3" style={{ borderColor: "var(--border)" }}>
                <p className="font-medium">{q.question}</p>
                <p style={{ color: "var(--muted)" }}>A: {q.answer}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
