"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestCarouselVisualRevisionAction } from "@/app/actions";

/**
 * Carousel visual revision v1: one critique → the next carousel version
 * with a revised VISUAL plan (approved copy never changes; generated
 * images are only reused). The new version's review email is sent
 * automatically; the previous version's approval link becomes stale.
 */
export function CarouselRevisionForm({ draftId, currentVersion }: { draftId: string; currentVersion: number }) {
  const router = useRouter();
  const [critique, setCritique] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await requestCarouselVisualRevisionAction(draftId, critique);
      if (result.status === "success") {
        setMessage(`Created carousel v${result.assetVersion}. Its review email is on its way; the v${currentVersion} approval link is now stale.`);
        setCritique("");
        router.refresh();
      } else {
        setMessage(result.message ?? "The visual revision could not be created.");
      }
    });
  }

  return (
    <div className="space-y-2 border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <label htmlFor="carousel-critique" className="block text-sm font-medium">
        Request visual changes (v{currentVersion} → v{currentVersion + 1})
      </label>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Revises only the visual direction. The approved slide texts, caption, CTA and hashtags stay exactly as approved; existing generated
        images can be reused, no new images are generated.
      </p>
      <textarea
        id="carousel-critique"
        className="w-full rounded border p-2 text-sm"
        style={{ borderColor: "var(--border)" }}
        rows={3}
        maxLength={800}
        value={critique}
        onChange={(e) => setCritique(e.target.value)}
        disabled={isPending}
        placeholder="e.g. Slides 2 and 4 look practically identical…"
      />
      <button
        type="button"
        onClick={submit}
        disabled={isPending || critique.trim().length < 3}
        className="rounded px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
        style={{ background: "var(--border)" }}
      >
        {isPending ? "Revising…" : "Request visual changes"}
      </button>
      {message && <p className="text-sm">{message}</p>}
    </div>
  );
}
