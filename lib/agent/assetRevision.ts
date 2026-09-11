import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow, ContentDraftRow } from "@/lib/types/database";
import type { AiClient } from "@/lib/agent/aiClient";
import { AssetStorageError, type AssetStorage } from "@/lib/agent/assetStorage";
import { renderImagePostAsset, AssetRenderError } from "@/lib/agent/assetRenderer";
import { getLatestAsset, resolveCachedVisualSources, buildVisualPlanProvenance, type CachedVisualSourceResolution } from "@/lib/agent/assetGenerator";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import {
  callAssetFeedbackInterpreter,
  estimateAssetFeedbackInputTokens,
  type AssetCompositionLayout,
  type AssetFeedbackContext,
} from "@/lib/agent/assetFeedbackInterpreter";
import type { AssetRenderSpec, AssetFeedbackInterpretation } from "@/lib/agent/schemas";
import { env } from "@/lib/env";
import { isUniqueViolation, recoverStaleRuns } from "@/lib/agent/runLock";

// "Request Changes": lets Alex give free-text visual feedback on the
// current/latest image_post asset (pending_review or ready_to_publish
// — approval never blocks further revision, see BRAND.md-independent
// spec section 6) and creates the next asset version from it. Unlike
// plain Generate/Regenerate (lib/agent/assetGenerator.ts), this makes
// exactly one OpenAI call — the bounded feedback interpreter — so it
// participates in the same BudgetGuard/agent_runs lock machinery as
// lib/agent/revision.ts's text-content revision flow.
//
// Safety is structural, not procedural: the interpreter can only ever
// return a validated AssetRenderSpec (five bounded enums — see
// lib/agent/schemas.ts). This function never writes to content_drafts,
// never derives new claims, and never lets feedback choose a different
// screenshot/proposal source — it can only adjust how the renderer
// presents whichever verified source the draft's own approved
// visualDirection/purpose/topic already select.

/** Purely explanatory — never re-fed into rendering. See assetFeedbackInterpretationSchema in lib/agent/schemas.ts. */
export interface AssetFeedbackInterpretationSummary {
  appliedChanges: string[];
  unsupportedRequests: string[];
}

export interface AssetRevisionOutcome {
  status: "success" | "ineligible" | "failed" | "concurrent" | "no_applicable_changes";
  asset?: ContentAssetRow;
  message?: string;
  /** True only when status === "failed" because the Budget Guard blocked the call — mirrors RegenerateOutcome.budgetBlocked in lib/agent/revision.ts. */
  budgetBlocked?: boolean;
  /** Present whenever the interpreter actually ran (status "success" or "no_applicable_changes") so the UI can show what was applied/unsupported. */
  interpretation?: AssetFeedbackInterpretationSummary;
}

const MIN_FEEDBACK_LENGTH = 3;
const MAX_FEEDBACK_LENGTH = 500;

/**
 * Derives the feedback interpreter's {layout, sourceDescription} context
 * from the CURRENT asset's actual effective strategy (the Visual
 * Director plan it was rendered with — see
 * lib/agent/assetGenerator.ts's resolveCachedVisualSources), not from
 * re-deriving a guess via keyword matching on the draft. This is what
 * keeps Request Changes' context honest for assets whose strategy was a
 * deliberate Visual Director choice that a naive keyword re-check could
 * disagree with. AssetCompositionLayout intentionally stays a 3-value
 * enum (spec: don't redesign Asset Feedback for this task) — generative
 * strategies without a proposal inset map to "text-only", the closest
 * existing category (no product/proposal imagery to describe rules
 * around), while a proposal inset (proposal_document, or hybrid with
 * one) still maps to "proposal-example" so the disclosure-emphasis
 * guidance still applies correctly.
 */
function describeCurrentSource(resolution: CachedVisualSourceResolution): { layout: AssetCompositionLayout; sourceDescription: string } {
  if (resolution.proposalMeta) {
    return { layout: "proposal-example", sourceDescription: resolution.proposalMeta.verifiedPurpose };
  }
  if (resolution.screenshotMeta) {
    return { layout: "product-screenshot", sourceDescription: resolution.screenshotMeta.visibleSubject };
  }
  if (resolution.strategy === "generated_photo" || resolution.strategy === "generated_illustration") {
    return {
      layout: "text-only",
      sourceDescription: `A generated supporting image is used as the background (concept: ${resolution.plan.creativeConcept}) — no verified product/proposal source is shown.`,
    };
  }
  return {
    layout: "text-only",
    sourceDescription: "No verified product/proposal visual source is selected for this draft — the composition is logo, headline and CTA only.",
  };
}

async function insertFailedRevision(
  db: SupabaseClient<Database>,
  draft: ContentDraftRow,
  nextVersion: number,
  message: string,
  feedback: string,
  revisedFromVersion: number,
  spec?: AssetRenderSpec,
  provenance?: Record<string, unknown>
): Promise<AssetRevisionOutcome> {
  const { data: failedRow, error: insertError } = await db
    .from("content_assets")
    .insert({
      draft_id: draft.id,
      brand: draft.brand,
      asset_version: nextVersion,
      source_draft_version: draft.version,
      status: "generation_failed",
      error_message: message,
      render_provenance: {
        ...(provenance ?? {}),
        ...(spec ? { renderSpec: spec } : {}),
        feedback: { text: feedback, revisedFromVersion },
      },
    })
    .select("*")
    .single();

  if (insertError) {
    if (isUniqueViolation(insertError)) {
      return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
    }
    return { status: "failed", message: `${message} (and the failure could not be recorded: ${insertError.message})` };
  }

  return { status: "failed", asset: failedRow, message };
}

async function performRevision(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  aiClient: AiClient;
  budgetGuard: BudgetGuard;
  agentRunId: string;
  draft: ContentDraftRow;
  latest: ContentAssetRow;
  feedback: string;
}): Promise<AssetRevisionOutcome> {
  const { db, storage, aiClient, budgetGuard, agentRunId, draft, latest, feedback } = params;

  const resolution = await resolveCachedVisualSources(storage, draft, latest);
  const currentSpec = resolution.plan.renderSpec;
  const { layout, sourceDescription } = describeCurrentSource(resolution);

  const context: AssetFeedbackContext = {
    visualDirection: draft.visual_direction ?? "",
    purpose: draft.purpose,
    topic: draft.topic,
    layout,
    sourceDescription,
    currentSpec,
    feedback,
  };

  const nextVersion = latest.asset_version + 1;

  const budgetCheck = await budgetGuard.checkBeforeCall({
    agentRunId,
    model: env.executorModel(),
    approxInputTokens: estimateAssetFeedbackInputTokens(context),
    approxMaxOutputTokens: 500,
  });
  if (!budgetCheck.allowed) {
    return { status: "failed", message: budgetCheck.reason, budgetBlocked: true };
  }

  let interpreterResult;
  try {
    interpreterResult = await callAssetFeedbackInterpreter(aiClient, context);
  } catch (err) {
    const message = `Feedback interpretation failed: ${err instanceof Error ? err.message : String(err)}`;
    return insertFailedRevision(db, draft, nextVersion, message, feedback, latest.asset_version);
  }

  await budgetGuard.recordUsage({
    agentRunId,
    brand: draft.brand,
    operation: "executor",
    model: interpreterResult.model,
    usage: interpreterResult.usage,
  });

  if (interpreterResult.incomplete || !interpreterResult.output) {
    const message = interpreterResult.incomplete
      ? `Feedback interpretation was cut off before completing (reason: ${interpreterResult.incomplete.reason}).`
      : "Feedback interpretation did not return a usable result.";
    return insertFailedRevision(db, draft, nextVersion, message, feedback, latest.asset_version);
  }

  const { renderSpec: validatedSpec, appliedChanges, unsupportedRequests }: AssetFeedbackInterpretation = interpreterResult.output;
  const interpretation: AssetFeedbackInterpretationSummary = { appliedChanges, unsupportedRequests };

  // None of the requested changes could be represented by the current
  // AssetRenderSpec — rendering with an unchanged spec would produce a
  // visually identical asset. Don't spend Storage/version history on
  // that; report the interpretation back without creating a new
  // content_assets row at all (not even a generation_failed one — this
  // isn't a failure, nothing was attempted).
  if (appliedChanges.length === 0) {
    return { status: "no_applicable_changes", message: "No requested visual change could be applied with the current renderer.", interpretation };
  }

  // Render using the asset's actual effective strategy/sources (the
  // resolution computed above), never re-deriving a source guess from
  // the draft's raw keywords — the interpreter only ever adjusts
  // renderSpec (validatedSpec), never the strategy/source itself.
  let rendered;
  try {
    rendered = await renderImagePostAsset({
      headline: draft.hook!,
      ctaText: draft.cta_text!,
      assetVersion: nextVersion,
      visualDirection: draft.visual_direction ?? "",
      purpose: draft.purpose,
      topic: draft.topic,
      renderSpec: validatedSpec,
      strategy: resolution.strategy,
      forceScreenshotMeta: resolution.screenshotMeta,
      forceProposalMeta: resolution.proposalMeta,
      generatedImage: resolution.generatedImage,
    });
  } catch (err) {
    const message = err instanceof AssetRenderError ? err.message : `Unexpected render error: ${err instanceof Error ? err.message : String(err)}`;
    return insertFailedRevision(db, draft, nextVersion, message, feedback, latest.asset_version, validatedSpec);
  }

  const storagePath = `${draft.id}/v${nextVersion}.png`;
  try {
    await storage.upload(storagePath, rendered.png, "image/png");
  } catch (err) {
    const message = err instanceof AssetStorageError ? err.message : `Unexpected storage error: ${err instanceof Error ? err.message : String(err)}`;
    return insertFailedRevision(db, draft, nextVersion, `Storage upload failed: ${message}`, feedback, latest.asset_version, validatedSpec, rendered.provenance);
  }

  const visualPlanProvenance = buildVisualPlanProvenance({
    plan: { ...resolution.plan, renderSpec: validatedSpec },
    strategy: resolution.strategy,
    origin: resolution.origin,
    degraded: resolution.degraded,
    degradeReason: resolution.degradeReason,
    generatedImageInfo: resolution.generatedImageInfo,
    draft,
  });

  const { data: asset, error: insertError } = await db
    .from("content_assets")
    .insert({
      draft_id: draft.id,
      brand: draft.brand,
      asset_version: nextVersion,
      source_draft_version: draft.version,
      status: "pending_review",
      format: "image_post",
      width: rendered.width,
      height: rendered.height,
      mime_type: "image/png",
      storage_bucket: "solardesk-assets",
      storage_path: storagePath,
      render_provenance: {
        ...rendered.provenance,
        ...visualPlanProvenance,
        feedback: {
          text: feedback,
          revisedFromVersion: latest.asset_version,
          revisedFromStatus: latest.status,
          appliedChanges,
          unsupportedRequests,
        },
      },
    })
    .select("*")
    .single();

  if (insertError || !asset) {
    if (isUniqueViolation(insertError)) {
      return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
    }
    return { status: "failed", message: `Generated asset could not be persisted: ${insertError?.message ?? "unknown error"}` };
  }

  return { status: "success", asset, interpretation };
}

/**
 * Manual-only entry point, same posture as generateAsset: reachable
 * only from an explicit Alex-initiated UI action (app/actions.ts),
 * never from runMarketingCycle or approveDraft. Always re-reads the
 * draft and the latest asset fresh from the DB. Never mutates
 * content_drafts. Never touches or supersedes the previous asset row —
 * a new content_assets row is always inserted, never updated.
 */
export async function requestAssetChanges(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  aiClient: AiClient;
  draftId: string;
  feedback: string;
}): Promise<AssetRevisionOutcome> {
  const { db, storage, aiClient, draftId } = params;
  const feedback = params.feedback.trim();

  if (feedback.length < MIN_FEEDBACK_LENGTH) {
    return { status: "ineligible", message: "Feedback is too short to act on — describe the visual change you want." };
  }
  if (feedback.length > MAX_FEEDBACK_LENGTH) {
    return { status: "ineligible", message: `Feedback is too long (max ${MAX_FEEDBACK_LENGTH} characters).` };
  }

  const { data: draft, error: draftError } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (draftError || !draft) {
    return { status: "ineligible", message: "Draft not found." };
  }
  if (draft.brand !== "solardesk") {
    return { status: "ineligible", message: "Asset revision is only supported for SolarDesk." };
  }
  if (draft.status !== "approved") {
    return { status: "ineligible", message: `Draft is in status "${draft.status}" — only an approved draft can revise an asset.` };
  }
  if (draft.content_type !== "image_post") {
    return { status: "ineligible", message: `Content type "${draft.content_type}" is not supported yet — only image_post.` };
  }
  if (!draft.hook || !draft.cta_text) {
    return { status: "ineligible", message: "The approved draft does not have enough approved text (hook/CTA) to render a safe asset." };
  }

  const latest = await getLatestAsset(db, draftId);
  if (!latest || (latest.status !== "pending_review" && latest.status !== "ready_to_publish")) {
    return {
      status: "ineligible",
      message: "There is no successfully generated asset to request changes on yet — generate an asset first.",
    };
  }

  await recoverStaleRuns(db, draft.brand);

  const { data: lockRun, error: lockError } = await db
    .from("agent_runs")
    .insert({ brand: draft.brand, trigger: "manual", kind: "revision", status: "running" })
    .select("*")
    .single();

  if (lockError) {
    if (isUniqueViolation(lockError)) {
      return { status: "concurrent", message: "Another SolarDesk agent operation is already running." };
    }
    return { status: "failed", message: lockError.message };
  }

  try {
    const budgetGuard = new BudgetGuard(db);
    const outcome = await performRevision({ db, storage, aiClient, budgetGuard, agentRunId: lockRun.id, draft, latest, feedback });

    if (outcome.budgetBlocked) {
      await db
        .from("agent_runs")
        .update({
          status: "skipped",
          decision: "BUDGET_BLOCKED",
          summary: outcome.message ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", lockRun.id);
      return outcome;
    }

    if (outcome.status === "success") {
      await db
        .from("agent_runs")
        .update({ status: "completed", summary: `Created asset revision v${outcome.asset!.asset_version} from feedback.`, completed_at: new Date().toISOString() })
        .eq("id", lockRun.id);
      return outcome;
    }

    if (outcome.status === "no_applicable_changes") {
      await db
        .from("agent_runs")
        .update({
          status: "completed",
          summary: "No requested visual change could be applied with the current renderer — no new asset version was created.",
          completed_at: new Date().toISOString(),
        })
        .eq("id", lockRun.id);
      return outcome;
    }

    await db
      .from("agent_runs")
      .update({
        status: "failed",
        error_code: "asset_revision_failed",
        error_message: outcome.message ?? "unknown",
        completed_at: new Date().toISOString(),
      })
      .eq("id", lockRun.id);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("agent_runs")
      .update({ status: "failed", error_code: "asset_revision_failed", error_message: message, completed_at: new Date().toISOString() })
      .eq("id", lockRun.id);
    return { status: "failed", message };
  }
}
