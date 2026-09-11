"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { generateAssetAction, approveAssetAction, requestAssetChangesAction } from "@/app/actions";
import type { ContentAssetRow } from "@/lib/types/database";
import type { AssetFeedbackInterpretationSummary } from "@/lib/agent/assetRevision";
import type { VisualStrategy } from "@/lib/agent/schemas";

const STRATEGY_LABEL: Record<VisualStrategy, string> = {
  product_ui: "Real product interface",
  proposal_document: "Real proposal document",
  branded_graphic: "Branded graphic (no photo)",
  generated_photo: "Generated photo",
  generated_illustration: "Generated illustration",
  hybrid: "Generated image + verified SolarDesk material",
};

/**
 * Reads the compact creative-direction summary AlexAgent's Visual
 * Director recorded for this asset (render_provenance.visualPlan) —
 * never raw JSON/enum names shown to Alex, and null-safe for any asset
 * that predates this feature (no visualPlan in its provenance).
 */
function getVisualPlanSummary(asset: ContentAssetRow): { strategyLabel: string; concept: string } | null {
  const provenance = asset.render_provenance as Record<string, unknown> | null;
  const visualPlan = provenance?.visualPlan as { strategy?: unknown; creativeConcept?: unknown } | undefined;
  if (!visualPlan || typeof visualPlan.strategy !== "string" || typeof visualPlan.creativeConcept !== "string") return null;
  const strategy = visualPlan.strategy as VisualStrategy;
  return { strategyLabel: STRATEGY_LABEL[strategy] ?? strategy, concept: visualPlan.creativeConcept };
}

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
  const [interpretation, setInterpretation] = useState<AssetFeedbackInterpretationSummary | null>(null);

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
    setInterpretation(null);
    startTransition(async () => {
      try {
        const result = await requestAssetChangesAction(draftId, trimmed);
        if (result.status === "success") {
          setShowFeedbackForm(false);
          setFeedback("");
          setInterpretation(result.interpretation ?? null);
        } else if (result.status === "no_applicable_changes") {
          // Not an error: the interpreter ran, but none of the requested
          // visual changes could be represented by the current renderer —
          // no new asset version was created. Show the same summary UI,
          // just with an empty "Applied" side.
          setInterpretation(result.interpretation ?? null);
        } else {
          setError(result.message ?? "Could not create a revision from that feedback.");
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

          {(() => {
            const visualSummary = getVisualPlanSummary(asset);
            if (!visualSummary) return null;
            return (
              <div className="text-xs space-y-0.5">
                <p>
                  <span className="font-medium">Visual strategy:</span> {visualSummary.strategyLabel}
                </p>
                <p style={{ color: "var(--muted)" }}>
                  <span className="font-medium" style={{ color: "inherit" }}>
                    Concept:
                  </span>{" "}
                  {visualSummary.concept}
                </p>
              </div>
            );
          })()}

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

      {interpretation && (interpretation.appliedChanges.length > 0 || interpretation.unsupportedRequests.length > 0) && (
        <div className="rounded-md border p-3 text-xs space-y-2" style={{ borderColor: "var(--border)" }}>
          {interpretation.appliedChanges.length > 0 ? (
            <div>
              <p className="font-semibold">Applied</p>
              <ul className="list-disc list-inside">
                {interpretation.appliedChanges.map((change, i) => (
                  <li key={i}>{change}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p>No requested visual change could currently be applied.</p>
          )}
          {interpretation.unsupportedRequests.length > 0 && (
            <div>
              <p className="font-semibold">Not supported</p>
              <ul className="list-disc list-inside" style={{ color: "var(--muted)" }}>
                {interpretation.unsupportedRequests.map((request, i) => (
                  <li key={i}>{request}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

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
