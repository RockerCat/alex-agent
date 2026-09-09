"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { answerQuestionAction } from "@/app/actions";

export function QuestionAnswerForm({ questionId }: { questionId: string }) {
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={2}
        placeholder="Your answer…"
        className="w-full rounded-md border px-3 py-2 text-sm"
        style={{ borderColor: "var(--border)", background: "var(--background)" }}
      />
      <button
        type="button"
        disabled={isPending || !answer.trim()}
        onClick={() => {
          setError(null);
          setNotice(null);
          startTransition(async () => {
            try {
              const result = await answerQuestionAction(questionId, answer.trim());
              if (!result.ok) {
                setError(result.message ?? "Could not save answer.");
                return;
              }
              if (result.resumed?.status === "revised") {
                setNotice("Answer saved — the blocked draft was automatically revised and is pending approval again.");
              }
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save answer.");
            }
          });
        }}
        className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
        style={{ background: "var(--accent)", color: "#0f172a" }}
      >
        {isPending ? "Saving…" : "Answer"}
      </button>
      {notice && <p className="text-sm" style={{ color: "var(--muted)" }}>{notice}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
