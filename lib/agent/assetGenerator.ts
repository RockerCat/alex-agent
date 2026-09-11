import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow, ContentDraftRow } from "@/lib/types/database";
import { renderImagePostAsset, AssetRenderError } from "@/lib/agent/assetRenderer";
import { AssetStorageError, type AssetStorage } from "@/lib/agent/assetStorage";
import {
  assetRenderSpecSchema,
  visualCreativePlanSchema,
  DEFAULT_RENDER_SPEC,
  type AssetRenderSpec,
  type VisualCreativePlan,
  type VisualStrategy,
} from "@/lib/agent/schemas";
import type { AiClient, VisualDirectorCallResult } from "@/lib/agent/aiClient";
import {
  type ImageGenerationClient,
  imageGenerationCapabilityAvailable,
  IMAGE_GENERATION_APPROX_INPUT_TOKENS,
  IMAGE_GENERATION_APPROX_OUTPUT_TOKENS,
} from "@/lib/agent/imageGenerationClient";
import { buildGenerativeImagePrompt } from "@/lib/agent/generativePromptBuilder";
import { callVisualDirector, estimateVisualDirectorInputTokens, type VisualDirectorContext } from "@/lib/agent/visualDirector";
import { resolveVisualSources } from "@/lib/agent/visualSourceResolver";
import { getRecentVisualStrategyHistory } from "@/lib/agent/visualHistory";
import { selectProductScreenshot, type ScreenshotMeta } from "@/lib/agent/productScreenshots";
import { selectProposalExample, type ProposalExampleMeta } from "@/lib/agent/proposalExamples";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import { env } from "@/lib/env";
import { isUniqueViolation, recoverStaleRuns } from "@/lib/agent/runLock";

// AlexAgent v0.2 — Visual Director. generateAsset() is the single entry
// point behind BOTH the "Generate Asset" and "Regenerate" buttons
// (same as before this feature): which behavior happens is decided by
// whether a content_assets row already exists for the draft, not by a
// separate function/flag.
//
// - First-time generation (no existing asset) WITH an aiClient: calls
//   the Visual Director once (budget-guarded, brand-locked via
//   agent_runs — same machinery lib/agent/assetRevision.ts already
//   uses), resolves its plan against the real verified catalogs, and
//   optionally calls the image-generation provider (separately
//   budget-guarded) when the resolved strategy needs one.
// - First-time generation WITHOUT an aiClient (omitted — e.g. many
//   existing tests, or any future caller that doesn't want AI
//   involved): degrades to the exact deterministic keyword-based
//   selection this feature replaces as the PRIMARY mechanism — this is
//   not a special case bolted on for tests, it is the same "Visual
//   Direction unavailable" safe fallback required when the Director
//   fails, reused for a client that was never supplied. No AI call, no
//   lock, no BudgetGuard/agent_settings dependency.
// - Regenerate (an asset already exists): ALWAYS zero AI cost —
//   reuses the previous asset's effective VisualCreativePlan/renderSpec
//   (carrying forward whatever Request Changes already dialed in,
//   exactly as before this feature) and, if that plan used generative
//   imagery, reuses the same cached generated image from Storage rather
//   than calling the provider again. If no cached image is available,
//   it degrades to branded_graphic rather than re-generating — it never
//   makes a paid call.
//
// Manual-only posture, safety boundary, and versioning/history
// guarantees are otherwise unchanged from the original vertical slice —
// see the doc comment on generateAsset() below.

/**
 * Extracts the render spec actually used for `asset`'s composition
 * (recorded in render_provenance.renderSpec by assetRenderer.ts), or
 * the default (today's original fixed layout) when there is no asset
 * yet, the asset predates this feature, or its provenance is somehow
 * malformed — never throws, so a corrupted/legacy provenance blob can
 * never block generation or revision.
 */
export function getEffectiveRenderSpec(asset: ContentAssetRow | null): AssetRenderSpec {
  if (!asset) return DEFAULT_RENDER_SPEC;
  const candidate = (asset.render_provenance as Record<string, unknown> | null)?.renderSpec;
  const parsed = assetRenderSpecSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_RENDER_SPEC;
}

export interface StoredVisualPlan {
  plan: VisualCreativePlan;
  generatedImageStoragePath: string | null;
}

/**
 * Extracts the validated VisualCreativePlan actually used for `asset`'s
 * composition (recorded in render_provenance.visualPlan), or null when
 * there is no asset, its provenance predates this feature, or is
 * somehow malformed — never throws. Callers (Regenerate, Request
 * Changes) must treat null as "fall back to deterministic keyword-based
 * selection", exactly the posture legacy pre-Visual-Director assets
 * (including the real live v1–v6 SolarDesk asset) already need.
 */
export function getEffectiveVisualPlan(asset: ContentAssetRow | null): StoredVisualPlan | null {
  if (!asset) return null;
  const raw = (asset.render_provenance as Record<string, unknown> | null)?.visualPlan as Record<string, unknown> | undefined;
  if (!raw) return null;
  const parsed = visualCreativePlanSchema.safeParse(raw);
  if (!parsed.success) return null;
  const generatedImage = raw.generatedImage as { storagePath?: string | null } | null | undefined;
  return { plan: parsed.data, generatedImageStoragePath: generatedImage?.storagePath ?? null };
}

export interface GenerateAssetOutcome {
  status: "success" | "ineligible" | "failed" | "concurrent";
  asset?: ContentAssetRow;
  message?: string;
  /** True only when status === "failed" because the Budget Guard blocked a call. */
  budgetBlocked?: boolean;
}

export async function getLatestAsset(
  db: SupabaseClient<Database>,
  draftId: string
): Promise<ContentAssetRow | null> {
  const { data } = await db
    .from("content_assets")
    .select("*")
    .eq("draft_id", draftId)
    .order("asset_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function listAssets(db: SupabaseClient<Database>, draftId: string): Promise<ContentAssetRow[]> {
  const { data } = await db
    .from("content_assets")
    .select("*")
    .eq("draft_id", draftId)
    .order("asset_version", { ascending: false });
  return data ?? [];
}

// Concise, fixed inventory of verified-source TYPES the Visual Director
// may request a category from — never the raw catalog internals or any
// binary content. Deliberately static (not derived from the catalog
// files at runtime): this is a small, hand-verified summary, same
// posture as VISUAL_CONSTRAINTS in assetFeedbackInterpreter.ts.
const AVAILABLE_VERIFIED_SOURCES_SUMMARY = [
  "product_screenshot: real, verified SolarDesk product UI (dashboard/overview, and the proposals list/management screen).",
  "proposal_example: one real, verified client-facing solar proposal PDF SolarDesk can generate (overview page + financial/system-detail page) — any use always shows a visible 'illustrative example' disclosure.",
  "logo: the official SolarDesk logo — always composited automatically regardless of strategy; never request it separately.",
].join("\n");

export interface GeneratedImageInfo {
  storagePath: string | null;
  model?: string;
  prompt?: string;
  revisedPrompt?: string;
  reused?: boolean;
}

interface DraftSelectionInput {
  visualDirection: string;
  purpose: string;
  topic: string;
}

function draftSelectionInput(draft: ContentDraftRow): DraftSelectionInput {
  return { visualDirection: draft.visual_direction ?? "", purpose: draft.purpose, topic: draft.topic };
}

/**
 * Safe deterministic fallback plan: reproduces exactly the same
 * proposal-takes-precedence-over-screenshot-takes-precedence-over-text-only
 * keyword logic this renderer always had, just expressed as a
 * VisualCreativePlan so it flows through the same resolve/render
 * pipeline as a real Visual Director plan (byte-identical output for
 * byte-identical inputs — see lib/agent/visualSourceResolver.ts, which
 * re-runs these exact same pure catalog functions). Used whenever the
 * Visual Director is unavailable, failed, or returned an unusable
 * response — never a special case bolted on for one caller.
 */
function deterministicFallbackPlan(draft: ContentDraftRow): VisualCreativePlan {
  const input = draftSelectionInput(draft);
  const proposal = selectProposalExample(input);
  const screenshot = proposal ? null : selectProductScreenshot(input);
  const strategy: VisualStrategy = proposal ? "proposal_document" : screenshot ? "product_ui" : "branded_graphic";
  return {
    strategy,
    creativeConcept: "Selección automática por palabras clave (Visual Director no disponible).",
    communicationGoal: "Comunicar el contenido aprobado del draft.",
    verifiedSourceCategory: proposal ? "proposal_example" : screenshot ? "product_screenshot" : "none",
    generativeSceneDescription: null,
    compositionIntent: proposal || screenshot ? "verified_dominant" : "graphic_text_dominant",
    renderSpec: DEFAULT_RENDER_SPEC,
    rationale: "Se usó la selección determinística por palabras clave existente porque el Visual Director no está disponible o falló.",
  };
}

export function buildVisualPlanProvenance(params: {
  plan: VisualCreativePlan;
  strategy: VisualStrategy;
  origin: "visual_director" | "fallback" | "reused_plan";
  degraded: boolean;
  degradeReason?: string;
  generatedImageInfo: GeneratedImageInfo | null;
  draft: ContentDraftRow;
}): Record<string, unknown> {
  const { plan, strategy, origin, degraded, degradeReason, generatedImageInfo, draft } = params;
  return {
    visualPlan: {
      ...plan,
      strategy, // final (possibly degraded) strategy — what was actually rendered
      requestedStrategy: plan.strategy !== strategy ? plan.strategy : undefined,
      origin,
      degraded,
      degradeReason,
      draftContext: { topic: draft.topic, purpose: draft.purpose },
      generatedImage: generatedImageInfo ? { used: true, ...generatedImageInfo } : { used: false },
    },
  };
}

async function insertFailedAssetRow(
  db: SupabaseClient<Database>,
  draft: ContentDraftRow,
  nextVersion: number,
  message: string,
  provenance: Record<string, unknown>
): Promise<GenerateAssetOutcome> {
  const { data: failedRow, error: insertError } = await db
    .from("content_assets")
    .insert({
      draft_id: draft.id,
      brand: draft.brand,
      asset_version: nextVersion,
      source_draft_version: draft.version,
      status: "generation_failed",
      error_message: message,
      render_provenance: provenance,
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

/**
 * Shared tail of every generation path: render the resolved
 * strategy/sources, upload, and persist the next content_assets
 * version. Never called with an inconsistent strategy/source pairing —
 * callers are responsible for resolution/degradation before reaching
 * here (this function trusts what it's given, matching the renderer's
 * own "execute, don't decide" posture).
 */
async function renderAndPersist(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  plan: VisualCreativePlan;
  strategy: VisualStrategy;
  screenshotMeta: ScreenshotMeta | null;
  proposalMeta: ProposalExampleMeta | null;
  generatedImage: Buffer | null;
  generatedImageInfo: GeneratedImageInfo | null;
  degraded: boolean;
  degradeReason?: string;
  origin: "visual_director" | "fallback" | "reused_plan";
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, plan, strategy, screenshotMeta, proposalMeta, generatedImage, generatedImageInfo, degraded, degradeReason, origin } =
    params;

  const planProvenance = buildVisualPlanProvenance({ plan, strategy, origin, degraded, degradeReason, generatedImageInfo, draft });

  let rendered;
  try {
    rendered = await renderImagePostAsset({
      headline: draft.hook!,
      ctaText: draft.cta_text!,
      assetVersion: nextVersion,
      visualDirection: draft.visual_direction ?? "",
      purpose: draft.purpose,
      topic: draft.topic,
      renderSpec: plan.renderSpec,
      strategy,
      forceScreenshotMeta: screenshotMeta,
      forceProposalMeta: proposalMeta,
      generatedImage,
    });
  } catch (err) {
    const message = err instanceof AssetRenderError ? err.message : `Unexpected render error: ${err instanceof Error ? err.message : String(err)}`;
    return insertFailedAssetRow(db, draft, nextVersion, message, planProvenance);
  }

  const storagePath = `${draft.id}/v${nextVersion}.png`;
  try {
    await storage.upload(storagePath, rendered.png, "image/png");
  } catch (err) {
    const message = err instanceof AssetStorageError ? err.message : `Unexpected storage error: ${err instanceof Error ? err.message : String(err)}`;
    return insertFailedAssetRow(db, draft, nextVersion, `Storage upload failed: ${message}`, { ...rendered.provenance, ...planProvenance });
  }

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
      render_provenance: { ...rendered.provenance, ...planProvenance },
    })
    .select("*")
    .single();

  if (insertError || !asset) {
    if (isUniqueViolation(insertError)) {
      return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
    }
    return { status: "failed", message: `Generated asset could not be persisted: ${insertError?.message ?? "unknown error"}` };
  }

  return { status: "success", asset };
}

/** First-time generation, no aiClient supplied — pure deterministic fallback, zero AI cost, zero lock. */
async function generateFirstAssetWithoutAi(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion } = params;
  const plan = deterministicFallbackPlan(draft);
  const resolved = resolveVisualSources(plan, draftSelectionInput(draft), false);
  return renderAndPersist({
    db,
    storage,
    draft,
    nextVersion,
    plan,
    strategy: resolved.strategy,
    screenshotMeta: resolved.screenshotMeta,
    proposalMeta: resolved.proposalMeta,
    generatedImage: null,
    generatedImageInfo: null,
    degraded: false,
    origin: "fallback",
  });
}

export interface CachedVisualSourceResolution {
  plan: VisualCreativePlan;
  strategy: VisualStrategy;
  screenshotMeta: ScreenshotMeta | null;
  proposalMeta: ProposalExampleMeta | null;
  generatedImage: Buffer | null;
  generatedImageInfo: GeneratedImageInfo | null;
  degraded: boolean;
  degradeReason?: string;
  origin: "reused_plan" | "fallback";
}

/**
 * Shared by Regenerate (below) and Request Changes
 * (lib/agent/assetRevision.ts): resolves an effective VisualCreativePlan
 * for a draft WITHOUT ever calling the Visual Director or the
 * image-generation provider — reuses the previous asset's persisted
 * plan (falling back to deterministic keyword selection for a legacy
 * asset with no persisted plan, e.g. the real pre-this-feature live
 * asset), and reuses a cached generated image from Storage when the
 * resolved strategy needs one, degrading to branded_graphic if no cache
 * is available rather than ever re-generating. `renderSpec` is left as
 * whatever the reused/fallback plan carries — callers that need a
 * DIFFERENT renderSpec (e.g. Request Changes' newly validated one) must
 * overwrite `plan.renderSpec` on the returned value before rendering.
 */
export async function resolveCachedVisualSources(
  storage: AssetStorage,
  draft: ContentDraftRow,
  previousAsset: ContentAssetRow
): Promise<CachedVisualSourceResolution> {
  const stored = getEffectiveVisualPlan(previousAsset);
  const renderSpec = getEffectiveRenderSpec(previousAsset);
  const plan: VisualCreativePlan = { ...(stored?.plan ?? deterministicFallbackPlan(draft)), renderSpec };

  // generativeCapabilityAvailable=true here does NOT mean "the live
  // image-generation API is configured" — this path never calls it. It
  // only lets the resolver keep a generative strategy's shape so the
  // cached-image reuse logic below gets a chance to run instead of
  // being pre-emptively collapsed to branded_graphic.
  const resolved = resolveVisualSources(plan, draftSelectionInput(draft), true);

  let generatedImage: Buffer | null = null;
  let generatedImageInfo: GeneratedImageInfo | null = null;
  let strategy = resolved.strategy;
  let degraded = resolved.degraded;
  let degradeReason = resolved.degradeReason;

  if (resolved.needsGeneratedImage) {
    const cachedPath = stored?.generatedImageStoragePath ?? null;
    if (cachedPath) {
      try {
        generatedImage = await storage.download(cachedPath);
        generatedImageInfo = { storagePath: cachedPath, reused: true };
      } catch {
        generatedImage = null;
      }
    }
    if (!generatedImage) {
      strategy = "branded_graphic";
      degraded = true;
      degradeReason =
        "No cached generated image available to reuse — degraded to branded_graphic (this path never calls the image provider).";
    }
  }

  const finalScreenshotMeta = strategy === resolved.strategy ? resolved.screenshotMeta : null;
  const finalProposalMeta = strategy === resolved.strategy ? resolved.proposalMeta : null;

  return {
    plan,
    strategy,
    screenshotMeta: finalScreenshotMeta,
    proposalMeta: finalProposalMeta,
    generatedImage,
    generatedImageInfo,
    degraded,
    degradeReason,
    origin: stored ? "reused_plan" : "fallback",
  };
}

/** Regenerate: an asset already exists for this draft. Always zero AI cost. */
async function regenerateFromPrevious(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  previousAsset: ContentAssetRow;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, previousAsset } = params;

  const resolution = await resolveCachedVisualSources(storage, draft, previousAsset);

  return renderAndPersist({
    db,
    storage,
    draft,
    nextVersion,
    plan: resolution.plan,
    strategy: resolution.strategy,
    screenshotMeta: resolution.screenshotMeta,
    proposalMeta: resolution.proposalMeta,
    generatedImage: resolution.generatedImage,
    generatedImageInfo: resolution.generatedImageInfo,
    degraded: resolution.degraded,
    degradeReason: resolution.degradeReason,
    origin: resolution.origin,
  });
}

/** First-time generation with a real Visual Director call, budget-guarded and brand-locked. */
async function performFirstGeneration(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  aiClient: AiClient;
  imageGenerationClient?: ImageGenerationClient;
  budgetGuard: BudgetGuard;
  agentRunId: string;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, aiClient, imageGenerationClient, budgetGuard, agentRunId } = params;

  const history = await getRecentVisualStrategyHistory(db, draft.brand);
  const generativeCapabilityAvailable = imageGenerationCapabilityAvailable() && !!imageGenerationClient;

  const context: VisualDirectorContext = {
    topic: draft.topic,
    purpose: draft.purpose,
    audience: draft.audience,
    hook: draft.hook!,
    ctaText: draft.cta_text!,
    visualDirection: draft.visual_direction ?? "",
    availableVerifiedSources: AVAILABLE_VERIFIED_SOURCES_SUMMARY,
    generativeCapabilityAvailable,
    recentHistory: history,
  };

  const budgetCheck = await budgetGuard.checkBeforeCall({
    agentRunId,
    model: env.executorModel(),
    approxInputTokens: estimateVisualDirectorInputTokens(context),
    approxMaxOutputTokens: 900,
  });
  if (!budgetCheck.allowed) {
    return { status: "failed", message: budgetCheck.reason, budgetBlocked: true };
  }

  let directorResult: VisualDirectorCallResult | undefined;
  let fallbackReason: string | undefined;
  try {
    directorResult = await callVisualDirector(aiClient, context);
  } catch (err) {
    fallbackReason = `Visual Director call failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (directorResult) {
    await budgetGuard.recordUsage({
      agentRunId,
      brand: draft.brand,
      operation: "executor",
      model: directorResult.model,
      usage: directorResult.usage,
    });
  }

  let plan: VisualCreativePlan;
  let origin: "visual_director" | "fallback";
  if (directorResult && !directorResult.incomplete && directorResult.output) {
    plan = directorResult.output;
    origin = "visual_director";
  } else {
    if (!fallbackReason) {
      fallbackReason = directorResult?.incomplete
        ? `Visual Director response was cut off (${directorResult.incomplete.reason}).`
        : "Visual Director did not return a usable plan.";
    }
    plan = deterministicFallbackPlan(draft);
    origin = "fallback";
  }

  const resolved = resolveVisualSources(plan, draftSelectionInput(draft), generativeCapabilityAvailable);

  let generatedImageBuffer: Buffer | null = null;
  let generatedImageInfo: GeneratedImageInfo | null = null;
  let finalStrategy = resolved.strategy;
  let finalDegraded = resolved.degraded;
  let finalDegradeReason = resolved.degradeReason ?? (origin === "fallback" ? fallbackReason : undefined);

  if (resolved.needsGeneratedImage) {
    if (!imageGenerationClient) {
      finalStrategy = "branded_graphic";
      finalDegraded = true;
      finalDegradeReason = "No image generation client configured.";
    } else {
      const { prompt } = buildGenerativeImagePrompt(plan);
      const imgBudgetCheck = await budgetGuard.checkBeforeCall({
        agentRunId,
        model: env.imageModel()!,
        approxInputTokens: IMAGE_GENERATION_APPROX_INPUT_TOKENS,
        approxMaxOutputTokens: IMAGE_GENERATION_APPROX_OUTPUT_TOKENS,
      });
      if (!imgBudgetCheck.allowed) {
        finalStrategy = "branded_graphic";
        finalDegraded = true;
        finalDegradeReason = `Image generation budget blocked: ${imgBudgetCheck.reason}`;
      } else {
        try {
          const genResult = await imageGenerationClient.generate({ prompt });
          await budgetGuard.recordUsage({
            agentRunId,
            brand: draft.brand,
            operation: "executor",
            model: genResult.model,
            usage: genResult.usage,
          });
          generatedImageBuffer = genResult.png;
          const genPath = `${draft.id}/generated/v${nextVersion}.png`;
          let storedPath: string | null = null;
          try {
            await storage.upload(genPath, genResult.png, "image/png");
            storedPath = genPath;
          } catch {
            storedPath = null; // Non-fatal: still composite this version from memory; a future Regenerate just can't cheaply reuse it.
          }
          generatedImageInfo = { storagePath: storedPath, model: genResult.model, prompt, revisedPrompt: genResult.revisedPrompt };
        } catch (err) {
          finalStrategy = "branded_graphic";
          finalDegraded = true;
          finalDegradeReason = `Image generation failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }

  const finalScreenshotMeta = finalStrategy === resolved.strategy ? resolved.screenshotMeta : null;
  const finalProposalMeta = finalStrategy === resolved.strategy ? resolved.proposalMeta : null;

  return renderAndPersist({
    db,
    storage,
    draft,
    nextVersion,
    plan,
    strategy: finalStrategy,
    screenshotMeta: finalScreenshotMeta,
    proposalMeta: finalProposalMeta,
    generatedImage: generatedImageBuffer,
    generatedImageInfo,
    degraded: finalDegraded,
    degradeReason: finalDegradeReason,
    origin,
  });
}

/** Brand lock + agent_runs bookkeeping around performFirstGeneration, mirroring lib/agent/assetRevision.ts's requestAssetChanges. */
async function generateFirstAssetWithDirector(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  aiClient: AiClient;
  imageGenerationClient?: ImageGenerationClient;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, aiClient, imageGenerationClient } = params;

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
    const outcome = await performFirstGeneration({ db, storage, draft, nextVersion, aiClient, imageGenerationClient, budgetGuard, agentRunId: lockRun.id });

    if (outcome.budgetBlocked) {
      await db
        .from("agent_runs")
        .update({ status: "skipped", decision: "BUDGET_BLOCKED", summary: outcome.message ?? null, completed_at: new Date().toISOString() })
        .eq("id", lockRun.id);
      return outcome;
    }

    if (outcome.status === "success") {
      await db
        .from("agent_runs")
        .update({
          status: "completed",
          summary: `Generated asset v${outcome.asset!.asset_version} via Visual Director.`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", lockRun.id);
      return outcome;
    }

    await db
      .from("agent_runs")
      .update({
        status: "failed",
        error_code: "asset_generation_failed",
        error_message: outcome.message ?? "unknown",
        completed_at: new Date().toISOString(),
      })
      .eq("id", lockRun.id);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("agent_runs")
      .update({ status: "failed", error_code: "asset_generation_failed", error_message: message, completed_at: new Date().toISOString() })
      .eq("id", lockRun.id);
    return { status: "failed", message };
  }
}

/**
 * Manual-only entry point: this must be called ONLY from an explicit
 * Alex-initiated UI action (Generate Asset / Regenerate). It is never
 * wired into runMarketingCycle or approveDraft — no background job and
 * no content approval automatically produces an asset.
 *
 * Always re-reads the draft fresh from the DB rather than trusting any
 * client-supplied state, so a stale/changed draft is caught here. Never
 * mutates content_drafts. Never touches or supersedes the previous asset row —
 * a new content_assets row is always inserted, never updated.
 *
 * `aiClient`/`imageGenerationClient` are optional: see this module's
 * top-of-file doc comment for exactly what each combination does.
 */
export async function generateAsset(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draftId: string;
  aiClient?: AiClient;
  imageGenerationClient?: ImageGenerationClient;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draftId, aiClient, imageGenerationClient } = params;

  const { data: draft, error: draftError } = await db.from("content_drafts").select("*").eq("id", draftId).single();
  if (draftError || !draft) {
    return { status: "ineligible", message: "Draft not found." };
  }
  if (draft.brand !== "solardesk") {
    return { status: "ineligible", message: "Asset generation is only supported for SolarDesk." };
  }
  if (draft.status !== "approved") {
    return { status: "ineligible", message: `Draft is in status "${draft.status}" — only an approved draft can generate an asset.` };
  }
  if (draft.content_type !== "image_post") {
    return { status: "ineligible", message: `Content type "${draft.content_type}" is not supported yet — only image_post.` };
  }
  if (!draft.hook || !draft.cta_text) {
    return { status: "ineligible", message: "The approved draft does not have enough approved text (hook/CTA) to render a safe asset." };
  }

  const existing = await listAssets(db, draftId);
  const nextVersion = (existing[0]?.asset_version ?? 0) + 1;

  if (existing[0]) {
    return regenerateFromPrevious({ db, storage, draft, nextVersion, previousAsset: existing[0] });
  }

  if (!aiClient) {
    return generateFirstAssetWithoutAi({ db, storage, draft, nextVersion });
  }

  return generateFirstAssetWithDirector({ db, storage, draft, nextVersion, aiClient, imageGenerationClient });
}

export interface ApproveAssetOutcome {
  ok: boolean;
  message?: string;
  asset?: ContentAssetRow;
}

export async function approveAsset(db: SupabaseClient<Database>, assetId: string): Promise<ApproveAssetOutcome> {
  const { data: asset, error } = await db.from("content_assets").select("*").eq("id", assetId).single();
  if (error || !asset) {
    return { ok: false, message: "Asset not found." };
  }
  if (asset.status !== "pending_review") {
    return { ok: false, message: `Asset is in status "${asset.status}" and cannot be approved right now.` };
  }

  const { data: updated, error: updateError } = await db
    .from("content_assets")
    .update({ status: "ready_to_publish", approved_at: new Date().toISOString() })
    .eq("id", assetId)
    .eq("status", "pending_review")
    .select("*")
    .single();

  if (updateError || !updated) {
    return { ok: false, message: updateError?.message ?? "Asset could not be approved (it may have changed state concurrently)." };
  }

  return { ok: true, asset: updated };
}
