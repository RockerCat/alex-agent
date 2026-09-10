"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateAssetAction, approveAssetAction, requestAssetChangesAction } from "@/app/actions";
import type { ContentAssetRow } from "@/lib/types/database";

const STATUS_LABEL: Record<ContentAssetRow["status"], string> = {
  pending_review: "Pending review",
  ready_to_publish: "Ready to publish",
  generation_failed: "Generation failed",
};

const STATUS_COLOR: Record<ContentAssetRow["status"], { bg: string; fg: string }> = {
  pending_review: { bg: "#dbeafe", fg: "#1e40af" },
  ready_to_publish: { bg: "#dcfce7", fg: "#166534" },
  generation_failed: { bg: "#fee2e2", fg: "#991b1b" },
};

export function AssetPanel({
  draftId,
  asset,
  previewUrl,
  history,
}: {
  draftId: string;
  asset: ContentAssetRow | null;
  previewUrl: string | null;
  history: ContentAssetRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showFeedbackForm, setShowFeedbackForm] = useState(false);
  const [feedback, setFeedback] = useState("");

  function generate() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await generateAssetAction(draftId);
        if (result.status === "ineligible" || result.status === "concurrent") {
          setError(result.message ?? "Could not generate the asset.");
        } else if (result.status === "failed") {
          setError(result.message ?? "Asset generation failed.");
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not generate the asset.");
      }
    });
  }

  function approve() {
    if (!asset) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await approveAssetAction(asset.id, draftId);
        if (!result.ok) setError(result.message ?? "Could not approve the asset.");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not approve the asset.");
      }
    });
  }

  function requestChanges() {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await requestAssetChangesAction(draftId, trimmed);
        if (result.status !== "success") {
          setError(result.message ?? "Could not create a revision from that feedback.");
        } else {
          setShowFeedbackForm(false);
          setFeedback("");
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not create a revision from that feedback.");
      }
    });
  }

  return (
    <div className="space-y-3">
      {!asset && (
        <div className="space-y-2">
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No asset has been generated yet for this approved draft.
          </p>
          <button
            type="button"
            disabled={isPending}
            onClick={generate}
            className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            style={{ background: "var(--accent)", color: "#0f172a" }}
          >
            {isPending ? "Generating…" : "Generate Asset"}
          </button>
        </div>
      )}

      {asset && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">v{asset.asset_version}</span>
            <span
              className="text-xs rounded-full px-2.5 py-1 font-semibold"
              style={{ background: STATUS_COLOR[asset.status].bg, color: STATUS_COLOR[asset.status].fg }}
            >
              {STATUS_LABEL[asset.status]}
            </span>
          </div>

          {asset.status === "generation_failed" && (
            <p className="text-sm text-red-600">{asset.error_message}</p>
          )}

          {previewUrl && (
            <img
              src={previewUrl}
              alt={`SolarDesk asset v${asset.asset_version}`}
              className="w-full max-w-xs rounded-md border"
              style={{ borderColor: "var(--border)" }}
            />
          )}

          {asset.width && asset.height && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {asset.width}×{asset.height} · {asset.format} · {asset.mime_type}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {asset.status === "pending_review" && (
              <button
                type="button"
                disabled={isPending}
                onClick={approve}
                className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{ background: "#16a34a", color: "white" }}
              >
                Approve Asset
              </button>
            )}
            {(asset.status === "pending_review" || asset.status === "ready_to_publish") && (
              <button
                type="button"
                disabled={isPending}
                onClick={() => setShowFeedbackForm((v) => !v)}
                className="rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{ borderColor: "var(--border)" }}
              >
                Request Changes
              </button>
            )}
            <button
              type="button"
              disabled={isPending}
              onClick={generate}
              className="rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}
            >
              {isPending ? "Regenerating…" : "Regenerate"}
            </button>
          </div>

          {showFeedbackForm && (asset.status === "pending_review" || asset.status === "ready_to_publish") && (
            <div className="rounded-md border p-3 space-y-2" style={{ borderColor: "var(--border)" }}>
              <label className="text-sm font-medium block">What should change visually?</label>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
                className="w-full rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)", background: "var(--background)" }}
                placeholder="Ej: Haz la propuesta un poco más grande y reduce el protagonismo del CTA."
              />
              <button
                type="button"
                disabled={isPending || !feedback.trim()}
                onClick={requestChanges}
                className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--accent)", color: "#0f172a" }}
              >
                {isPending ? "Generating revision…" : "Generate Revision"}
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {history.length > 0 && (
        <div>
          <p className="text-xs font-medium mt-2" style={{ color: "var(--muted)" }}>
            Previous versions
          </p>
          <ul className="text-xs space-y-1 mt-1" style={{ color: "var(--muted)" }}>
            {history.map((h) => (
              <li key={h.id}>
                v{h.asset_version} — {STATUS_LABEL[h.status]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
