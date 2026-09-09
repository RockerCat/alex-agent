"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from "@/lib/agent/constants";
import { approveDraftAction, rejectDraftAction, requestRevisionAction } from "@/app/actions";

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  too_generic: "Too generic",
  too_promotional: "Too promotional",
  too_long: "Too long",
  too_technical: "Too technical",
  wrong_tone: "Wrong tone",
  weak_hook: "Weak hook",
  weak_cta: "Weak CTA",
  factually_incorrect: "Factually incorrect",
  visual_needs_work: "Visual needs work",
  other: "Other",
};

export function DraftActions({ draftId, canAct }: { draftId: string; canAct: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showRevisionForm, setShowRevisionForm] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("weak_hook");
  const [note, setNote] = useState("");

  if (!canAct) return null;

  function run(fn: () => Promise<unknown>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => approveDraftAction(draftId))}
          className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: "#16a34a", color: "white" }}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setShowRevisionForm((v) => !v)}
          className="rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ borderColor: "var(--border)" }}
        >
          Request Revision
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => rejectDraftAction(draftId))}
          className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
          style={{ background: "#dc2626", color: "white" }}
        >
          Reject
        </button>
      </div>

      {showRevisionForm && (
        <div className="rounded-md border p-3 space-y-2" style={{ borderColor: "var(--border)" }}>
          <label className="text-sm font-medium block">Feedback category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: "var(--border)", background: "var(--background)" }}
          >
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <label className="text-sm font-medium block">Note (optional)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: "var(--border)", background: "var(--background)" }}
            placeholder="Anything specific AlexAgent should fix…"
          />
          <button
            type="button"
            disabled={isPending}
            onClick={() =>
              run(async () => {
                const result = await requestRevisionAction(draftId, category, note);
                if (result.status === "blocked_on_question") {
                  setNotice("Revision needs a business answer first — check Questions.");
                } else if (result.status === "failed" || result.status === "concurrent") {
                  setError(result.message ?? "Revision could not be completed.");
                } else {
                  setShowRevisionForm(false);
                  setNote("");
                }
              })
            }
            className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#0f172a" }}
          >
            {isPending ? "Requesting…" : "Submit revision request"}
          </button>
        </div>
      )}

      {notice && <p className="text-sm" style={{ color: "var(--muted)" }}>{notice}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
