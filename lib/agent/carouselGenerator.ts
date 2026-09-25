import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow, ContentDraftRow, CarouselSlideRecord } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import { AssetStorageError } from "@/lib/agent/assetStorage";
import {
  renderImagePostAsset,
  AssetRenderError,
  resolveFeasibleCtaEmphasis,
  addSlideMarker,
  toPublicationJpeg,
  IMAGE_POST_WIDTH,
  IMAGE_POST_HEIGHT,
} from "@/lib/agent/assetRenderer";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";
import {
  CAROUSEL_MAX_GENERATED_SLIDES,
  carouselVisualPlanSchema,
  type CarouselVisualPlan,
} from "@/lib/agent/schemas";
import {
  imageGenerationCapabilityAvailable,
  IMAGE_GENERATION_APPROX_INPUT_TOKENS,
  IMAGE_GENERATION_APPROX_OUTPUT_TOKENS,
  type ImageGenerationClient,
} from "@/lib/agent/imageGenerationClient";
import { buildGenerativeImagePrompt } from "@/lib/agent/generativePromptBuilder";
import {
  callCarouselVisualDirector,
  estimateCarouselVisualDirectorInputTokens,
  type CarouselVisualDirectorContext,
} from "@/lib/agent/visualDirector";
import type { CarouselVisualDirectorCallResult } from "@/lib/agent/aiClient";
import { assessVariety, describeAssetTreatment, getRecentVisualHistory, type RecentVisualHistory } from "@/lib/agent/visualHistory";
import {
  approvedCarouselSlides,
  carouselPlanShapeError,
  dominantStrategy,
  fallbackCarouselPlan,
  findRepeatedTreatments,
  slideTreatmentSignature,
  planCarouselSlides,
  type ApprovedCarouselSlide,
  type PlannedCarouselSlide,
} from "@/lib/agent/carouselPlan";
import { preCallEstimateUsd } from "@/lib/agent/pricing";
import { PER_RUN_AI_BUDGET_USD } from "@/lib/agent/constants";
import { env } from "@/lib/env";
import { isUniqueViolation } from "@/lib/agent/runLock";
import {
  AVAILABLE_VERIFIED_SOURCES_SUMMARY,
  draftSelectionInput,
  type FirstGenerationParams,
  type GenerateAssetOutcome,
} from "@/lib/agent/assetGenerator";

// Instagram carousel v1 — generation. One carousel version is ONE
// content_assets row (format 'carousel') whose ordered `slides` array is
// authoritative for the review email and publication; it reuses every
// existing single-asset guard (version tokens, approve_asset_if_current,
// the (asset_id, channel) publication claim). N approved slides → exactly
// N images, CTA pill only on the last one, a subtle i/N marker on each.
//
// Paid calls, in order, all inside the caller's brand lock
// (assetGenerator.ts generateFirstAssetWithDirector): ONE carousel Visual
// Director call, then at most CAROUSEL_MAX_GENERATED_SLIDES image calls —
// only after text fit/source/cap planning (carouselPlan.ts) and an
// aggregate Budget Guard check covering all of them, each still preceded
// by its own authoritative per-call check. Every generated source is
// cached immediately under a version+position path and recorded, so a
// later rerender/Regenerate reuses it and never pays again.

export const CAROUSEL_RENDERER = "svg-sharp-carousel-v1";
const CAROUSEL_VISUAL_DIRECTOR_APPROX_OUTPUT_TOKENS = 2000;

export function carouselSlidePath(draftId: string, assetVersion: number, position: number): string {
  return `${draftId}/v${assetVersion}/slide-${position}.jpg`;
}
export function carouselGeneratedSourcePath(draftId: string, assetVersion: number, position: number): string {
  return `${draftId}/generated/v${assetVersion}/slide-${position}.png`;
}

/** Eligibility beyond generateAsset's shared checks: Instagram only (Facebook carousel publishing is unsupported), clean 1..N slides. */
export function carouselIneligibilityReason(draft: { channel: string; body: ContentDraftRow["body"] }): string | null {
  if (draft.channel !== "instagram") return `Carousel assets are only supported for Instagram (draft channel is "${draft.channel}").`;
  if (!approvedCarouselSlides(draft)) return "The approved carousel does not have a clean ordered set of slide texts (slides 1..N, non-empty).";
  return null;
}

interface SlideImageSource {
  buffer: Buffer | null;
  info: { used: boolean; storagePath?: string | null; model?: string; prompt?: string; revisedPrompt?: string; reused?: boolean };
}

interface CarouselProduction {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  plan: CarouselVisualPlan;
  origin: CarouselPlanOrigin;
  fallbackReason?: string;
  slides: PlannedCarouselSlide[];
  sources: Map<number, SlideImageSource>;
  varietyHistory?: RecentVisualHistory;
  /** Extra durable fields merged into visualPlan provenance (e.g. carousel visual revision details). */
  extraPlanProvenance?: Record<string, unknown>;
}

export type CarouselPlanOrigin = "visual_director" | "fallback" | "reused_plan" | "revision";

/** The cached generated source a slide composites (reused or newly generated), if any. */
const sourcePathOf = (source: SlideImageSource | undefined) => (source?.info.used ? (source.info.storagePath ?? null) : null);

function slideProvenance(slide: PlannedCarouselSlide, source: SlideImageSource | undefined, spec: CarouselVisualPlan["renderSpec"], rendered?: Record<string, unknown>) {
  return {
    position: slide.position,
    requestedStrategy: slide.requestedStrategy,
    strategy: slide.strategy,
    ...(slide.proposalFocus ? { proposalFocus: slide.proposalFocus } : {}),
    // Only a REUSED generated source can make two slides identical; a newly generated image is unique.
    treatmentSignature: slideTreatmentSignature(slide, spec, source?.info.reused ? sourcePathOf(source) : null),
    degradeReasons: slide.degradeReasons,
    generatedImage: source?.info ?? { used: false },
    ...(rendered ? { rendered } : {}),
  };
}

function carouselProvenance(p: CarouselProduction, perSlide: ReturnType<typeof slideProvenance>[]): Record<string, unknown> {
  const strategies = p.slides.map((s) => s.strategy);
  const degraded = p.origin === "fallback" || p.slides.some((s) => s.degradeReasons.length > 0);
  const reused = new Map<number, string>();
  for (const s of p.slides) {
    const source = p.sources.get(s.position);
    const path = source?.info.reused ? sourcePathOf(source) : null;
    if (path) reused.set(s.position, path);
  }
  return {
    renderer: CAROUSEL_RENDERER,
    theme: p.nextVersion % 2 === 1 ? "a" : "b",
    renderSpec: p.plan.renderSpec,
    slideCount: p.slides.length,
    carouselSlides: perSlide,
    visualPlan: {
      kind: "carousel",
      ...p.plan,
      strategy: dominantStrategy(strategies), // what the carousel actually shows most — used by visual history
      origin: p.origin,
      degraded,
      degradeReason: p.fallbackReason,
      draftContext: { topic: p.draft.topic, purpose: p.draft.purpose },
      generatedImage: { used: perSlide.some((s) => s.generatedImage.used) },
      // Deterministic record of slides that show the identical visual treatment (and whether that was declared intentional).
      intraCarouselRepeats: findRepeatedTreatments(p.slides, p.plan.renderSpec, p.plan.repetitionJustification, reused),
      ...(p.extraPlanProvenance ?? {}),
    },
  };
}

async function insertFailedCarousel(
  p: Pick<CarouselProduction, "db" | "draft" | "nextVersion">,
  message: string,
  provenance: Record<string, unknown>
): Promise<GenerateAssetOutcome> {
  const { data: failedRow, error } = await p.db
    .from("content_assets")
    .insert({
      draft_id: p.draft.id,
      brand: p.draft.brand,
      asset_version: p.nextVersion,
      source_draft_version: p.draft.version,
      status: "generation_failed",
      format: "carousel",
      slides: [],
      error_message: message,
      render_provenance: provenance,
    })
    .select("*")
    .single();
  if (error) {
    if (isUniqueViolation(error)) return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
    return { status: "failed", message: `${message} (and the failure could not be recorded: ${error.message})` };
  }
  return { status: "failed", asset: failedRow, message };
}

/**
 * Renders every slide in order, then uploads every JPEG, then inserts the
 * ONE carousel row. Nothing is exposed for review unless every slide
 * rendered and stored: any failure records a single generation_failed
 * row naming the failing slide (with each slide's plan and cached
 * generated source, so a retry can reuse them without paying again).
 */
async function renderAndPersistCarousel(p: CarouselProduction): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, plan, slides, sources } = p;
  const { label: ctaLabel } = resolveCtaLabelAndUrl(draft);
  const feasibility = resolveFeasibleCtaEmphasis(ctaLabel, plan.renderSpec.ctaEmphasis);
  const plannedProvenance = () => carouselProvenance(p, slides.map((s) => slideProvenance(s, sources.get(s.position), plan.renderSpec)));
  if (!feasibility.fits) {
    return insertFailedCarousel(p, `The approved CTA label "${ctaLabel}" does not fit within any supported CTA emphasis level and cannot be rendered safely. Shorten the CTA label.`, plannedProvenance());
  }
  const lastSpec = { ...plan.renderSpec, ctaEmphasis: feasibility.emphasis };

  const rendered: { slide: PlannedCarouselSlide; jpeg: Buffer; provenance: Record<string, unknown> }[] = [];
  for (const slide of slides) {
    const isLast = slide.position === slides.length;
    try {
      const result = await renderImagePostAsset({
        headline: slide.text,
        ctaText: isLast ? ctaLabel : null,
        assetVersion: nextVersion,
        visualDirection: draft.visual_direction ?? "",
        purpose: draft.purpose,
        topic: draft.topic,
        renderSpec: isLast ? lastSpec : plan.renderSpec,
        strategy: slide.strategy,
        forceScreenshotMeta: slide.screenshotMeta,
        forceProposalMeta: slide.proposalMeta,
        proposalFocus: slide.proposalFocus ?? undefined,
        generatedImage: sources.get(slide.position)?.buffer ?? null,
      });
      const withMarker = await addSlideMarker(result.png, slide.position, slides.length);
      rendered.push({ slide, jpeg: await toPublicationJpeg(withMarker), provenance: result.provenance });
    } catch (err) {
      const reason = err instanceof AssetRenderError ? err.message : `Unexpected render error: ${err instanceof Error ? err.message : String(err)}`;
      return insertFailedCarousel(p, `Slide ${slide.position} of ${slides.length} could not be rendered: ${reason}`, { ...plannedProvenance(), failedSlide: slide.position });
    }
  }

  const records: CarouselSlideRecord[] = [];
  for (const r of rendered) {
    const path = carouselSlidePath(draft.id, nextVersion, r.slide.position);
    try {
      await storage.upload(path, r.jpeg, "image/jpeg");
    } catch (err) {
      const reason = err instanceof AssetStorageError ? err.message : `Unexpected storage error: ${err instanceof Error ? err.message : String(err)}`;
      return insertFailedCarousel(p, `Storage upload failed for slide ${r.slide.position} of ${slides.length}: ${reason}`, { ...plannedProvenance(), failedSlide: r.slide.position });
    }
    records.push({ position: r.slide.position, storage_path: path, width: IMAGE_POST_WIDTH, height: IMAGE_POST_HEIGHT, mime_type: "image/jpeg" });
  }

  const provenance = carouselProvenance(
    p,
    rendered.map((r) => slideProvenance(r.slide, sources.get(r.slide.position), plan.renderSpec, r.provenance))
  );
  if (p.varietyHistory) {
    const treatment = describeAssetTreatment(provenance);
    if (treatment) {
      provenance.visualPlan = { ...(provenance.visualPlan as Record<string, unknown>), varietyAssessment: assessVariety(treatment, draft.channel, p.varietyHistory) };
    }
  }

  const { data: asset, error } = await db
    .from("content_assets")
    .insert({
      draft_id: draft.id,
      brand: draft.brand,
      asset_version: nextVersion,
      source_draft_version: draft.version,
      status: "pending_review",
      format: "carousel",
      width: IMAGE_POST_WIDTH,
      height: IMAGE_POST_HEIGHT,
      mime_type: "image/jpeg",
      storage_bucket: "solardesk-assets",
      storage_path: records[0].storage_path, // slide 1: preview-compatible for single-image readers
      slides: records,
      render_provenance: provenance,
    })
    .select("*")
    .single();
  if (error || !asset) {
    if (isUniqueViolation(error)) return { status: "concurrent", message: "Another generation for this draft is already in progress. Please try again." };
    return { status: "failed", message: `Generated carousel could not be persisted: ${error?.message ?? "unknown error"}` };
  }
  return { status: "success", asset };
}

function downgrade(slide: PlannedCarouselSlide, reason: string): PlannedCarouselSlide {
  return {
    ...slide,
    strategy: "branded_graphic",
    screenshotMeta: null,
    proposalMeta: null,
    proposalFocus: null,
    needsGeneratedImage: false,
    degradeReasons: [...slide.degradeReasons, reason],
  };
}

/**
 * Paid image generation for the planned generated slides (≤ the v1 cap).
 * One aggregate Budget Guard check first — if the budget can't cover
 * them all, NO paid call is made and every one is downgraded — then the
 * authoritative per-call check before each call. A failed or blocked
 * call downgrades only its own slide. Each success is cached right away.
 */
async function generateSlideImages(
  base: { draft: ContentDraftRow; nextVersion: number; storage: AssetStorage },
  paid: PaidGeneration,
  slides: PlannedCarouselSlide[]
): Promise<{ slides: PlannedCarouselSlide[]; sources: Map<number, SlideImageSource> }> {
  const { draft, nextVersion, storage } = base;
  const { budgetGuard, agentRunId, imageGenerationClient } = paid;
  const sources = new Map<number, SlideImageSource>();
  const wanted = slides.filter((s) => s.needsGeneratedImage);
  if (wanted.length === 0) return { slides, sources };

  if (!imageGenerationClient) {
    return { slides: slides.map((s) => (s.needsGeneratedImage ? downgrade(s, "No image generation client configured.") : s)), sources };
  }
  const model = env.imageModel()!;
  const aggregate = await budgetGuard.checkBeforeCall({
    agentRunId,
    model,
    approxInputTokens: IMAGE_GENERATION_APPROX_INPUT_TOKENS * wanted.length,
    approxMaxOutputTokens: IMAGE_GENERATION_APPROX_OUTPUT_TOKENS * wanted.length,
  });
  if (!aggregate.allowed) {
    const reason = `Image generation budget blocked for ${wanted.length} generated slide(s): ${aggregate.reason}`;
    return { slides: slides.map((s) => (s.needsGeneratedImage ? downgrade(s, reason) : s)), sources };
  }

  const out: PlannedCarouselSlide[] = [];
  for (const slide of slides) {
    if (!slide.needsGeneratedImage) {
      out.push(slide);
      continue;
    }
    const check = await budgetGuard.checkBeforeCall({
      agentRunId,
      model,
      approxInputTokens: IMAGE_GENERATION_APPROX_INPUT_TOKENS,
      approxMaxOutputTokens: IMAGE_GENERATION_APPROX_OUTPUT_TOKENS,
    });
    if (!check.allowed) {
      out.push(downgrade(slide, `Image generation budget blocked: ${check.reason}`));
      continue;
    }
    const { prompt } = buildGenerativeImagePrompt(slide.slidePlan);
    try {
      const result = await imageGenerationClient.generate({ prompt });
      await budgetGuard.recordUsage({ agentRunId, brand: draft.brand, operation: "executor", model: result.model, usage: result.usage });
      const cachePath = carouselGeneratedSourcePath(draft.id, nextVersion, slide.position);
      let storagePath: string | null = null;
      try {
        await storage.upload(cachePath, result.png, "image/png");
        storagePath = cachePath;
      } catch {
        storagePath = null; // Non-fatal: this version still composites from memory; a later rerender just can't reuse it.
      }
      sources.set(slide.position, { buffer: result.png, info: { used: true, storagePath, model: result.model, prompt, revisedPrompt: result.revisedPrompt } });
      out.push({ ...slide, needsGeneratedImage: false });
    } catch (err) {
      out.push(downgrade(slide, `Image generation failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return { slides: out, sources };
}

/** First carousel generation (called inside the brand lock by assetGenerator.ts generateFirstAssetWithDirector). */
export async function performCarouselFirstGeneration(params: FirstGenerationParams): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, aiClient, imageGenerationClient, budgetGuard, agentRunId } = params;
  const approved = approvedCarouselSlides(draft);
  if (!approved) return { status: "ineligible", message: "The approved carousel does not have a clean ordered set of slide texts." };

  const history = await getRecentVisualHistory(db, draft.brand);
  const generativeCapabilityAvailable = imageGenerationCapabilityAvailable() && !!imageGenerationClient;
  const imageModel = env.imageModel();
  const imageEstimateUsd =
    generativeCapabilityAvailable && imageModel
      ? preCallEstimateUsd(imageModel, IMAGE_GENERATION_APPROX_INPUT_TOKENS, IMAGE_GENERATION_APPROX_OUTPUT_TOKENS)
      : null;

  const context: CarouselVisualDirectorContext = {
    topic: draft.topic,
    purpose: draft.purpose,
    audience: draft.audience,
    hook: draft.hook!,
    ctaText: resolveCtaLabelAndUrl(draft).label,
    visualDirection: draft.visual_direction ?? "",
    channel: draft.channel,
    availableVerifiedSources: AVAILABLE_VERIFIED_SOURCES_SUMMARY,
    generativeCapabilityAvailable,
    generativeBudget: { approxCostUsd: imageEstimateUsd, budgetPermits: false, generations: CAROUSEL_MAX_GENERATED_SLIDES },
    recentHistory: history,
    slides: approved.map((s) => ({ slideNumber: s.position, text: s.text })),
    maxGeneratedSlides: CAROUSEL_MAX_GENERATED_SLIDES,
  };
  const directorEstimateInputTokens = estimateCarouselVisualDirectorInputTokens(context);

  // Informational hint only (see visualDirector.ts); the checks below stay authoritative.
  if (imageEstimateUsd !== null) {
    const snapshot = await budgetGuard.getSnapshot();
    const needed =
      preCallEstimateUsd(env.executorModel(), directorEstimateInputTokens, CAROUSEL_VISUAL_DIRECTOR_APPROX_OUTPUT_TOKENS) +
      imageEstimateUsd * CAROUSEL_MAX_GENERATED_SLIDES;
    context.generativeBudget.budgetPermits =
      snapshot.monthlySpentUsd + needed <= snapshot.effectiveStopUsd && needed <= Math.min(snapshot.perRunBudgetUsd, PER_RUN_AI_BUDGET_USD);
  }

  const budgetCheck = await budgetGuard.checkBeforeCall({
    agentRunId,
    model: env.executorModel(),
    approxInputTokens: estimateCarouselVisualDirectorInputTokens(context),
    approxMaxOutputTokens: CAROUSEL_VISUAL_DIRECTOR_APPROX_OUTPUT_TOKENS,
  });
  if (!budgetCheck.allowed) {
    return { status: "failed", message: budgetCheck.reason, budgetBlocked: true };
  }

  let result: CarouselVisualDirectorCallResult | undefined;
  let fallbackReason: string | undefined;
  try {
    result = await callCarouselVisualDirector(aiClient, context);
  } catch (err) {
    fallbackReason = `Carousel Visual Director call failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (result) {
    await budgetGuard.recordUsage({ agentRunId, brand: draft.brand, operation: "executor", model: result.model, usage: result.usage });
  }

  let plan: CarouselVisualPlan;
  let origin: "visual_director" | "fallback";
  const shapeError = result?.output ? carouselPlanShapeError(result.output, approved.length) : null;
  if (result?.output && !result.incomplete && !shapeError) {
    plan = result.output;
    origin = "visual_director";
  } else {
    fallbackReason ??= shapeError ?? (result?.incomplete ? `Carousel Visual Director response was cut off (${result.incomplete.reason}).` : "Carousel Visual Director did not return a usable plan.");
    plan = fallbackCarouselPlan(approved.length);
    origin = "fallback";
  }

  return produceCarousel({
    db,
    storage,
    draft,
    nextVersion,
    approved,
    plan,
    origin,
    fallbackReason,
    generativeCapabilityAvailable,
    varietyHistory: history,
    cache: new Map(),
    paid: { budgetGuard, agentRunId, imageGenerationClient },
  });
}

interface PaidGeneration {
  budgetGuard: FirstGenerationParams["budgetGuard"];
  agentRunId: string;
  imageGenerationClient?: ImageGenerationClient;
}

export async function produceCarousel(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  approved: ApprovedCarouselSlide[];
  plan: CarouselVisualPlan;
  origin: CarouselPlanOrigin;
  fallbackReason?: string;
  generativeCapabilityAvailable: boolean;
  varietyHistory?: RecentVisualHistory;
  /** position → previously cached generated source path (Regenerate, or an accepted revision reuse). */
  cache: Map<number, string>;
  /** Present ONLY for first generation. Absent → the image provider is structurally unreachable. */
  paid?: PaidGeneration;
  /** Why a generated slide without a reusable cached source is downgraded when `paid` is absent. */
  noCacheReason?: string;
  extraPlanProvenance?: Record<string, unknown>;
}): Promise<GenerateAssetOutcome> {
  const { db, storage, draft, nextVersion, approved, plan, origin, fallbackReason, cache } = params;
  const planning = planCarouselSlides(plan, approved, draftSelectionInput(draft), { generativeCapabilityAvailable: params.generativeCapabilityAvailable });
  if (!planning.ok) {
    // Fails before ANY paid image call.
    return insertFailedCarousel({ db, draft, nextVersion }, planning.reason, {
      renderer: CAROUSEL_RENDERER,
      visualPlan: { kind: "carousel", ...plan, origin, degradeReason: fallbackReason, draftContext: { topic: draft.topic, purpose: draft.purpose } },
    });
  }

  let slides = planning.slides;
  const sources = new Map<number, SlideImageSource>();
  // Reuse cached generated sources first — never pay for a slide we already paid for.
  slides = await Promise.all(
    slides.map(async (slide) => {
      const cachedPath = slide.needsGeneratedImage ? cache.get(slide.position) : undefined;
      if (!cachedPath) return slide;
      try {
        sources.set(slide.position, { buffer: await storage.download(cachedPath), info: { used: true, storagePath: cachedPath, reused: true } });
        return { ...slide, needsGeneratedImage: false };
      } catch {
        return slide;
      }
    })
  );
  if (params.paid) {
    const generated = await generateSlideImages({ draft, nextVersion, storage }, params.paid, slides);
    slides = generated.slides;
    for (const [position, source] of generated.sources) sources.set(position, source);
  } else {
    slides = slides.map((s) =>
      s.needsGeneratedImage
        ? downgrade(s, params.noCacheReason ?? "No cached generated image available to reuse — this path never calls the image provider.")
        : s
    );
  }

  return renderAndPersistCarousel({
    db,
    storage,
    draft,
    nextVersion,
    plan,
    origin,
    fallbackReason,
    slides,
    sources,
    varietyHistory: params.varietyHistory,
    extraPlanProvenance: params.extraPlanProvenance,
  });
}

/** Stored carousel plan of a previous version (null for none/malformed), plus its cached generated sources by slide position. */
function storedCarouselPlan(previous: ContentAssetRow): { plan: CarouselVisualPlan | null; cache: Map<number, string> } {
  const provenance = (previous.render_provenance ?? {}) as Record<string, unknown>;
  const parsed = carouselVisualPlanSchema.safeParse(provenance.visualPlan);
  const cache = new Map<number, string>();
  const perSlide = Array.isArray(provenance.carouselSlides) ? provenance.carouselSlides : [];
  for (const s of perSlide as { position?: unknown; generatedImage?: { storagePath?: unknown } }[]) {
    if (typeof s?.position === "number" && typeof s.generatedImage?.storagePath === "string") cache.set(s.position, s.generatedImage.storagePath);
  }
  return { plan: parsed.success ? parsed.data : null, cache };
}

/**
 * Regenerate (a carousel asset already exists — including a
 * generation_failed one): reuses the stored carousel plan and every
 * cached generated slide source. Zero AI cost: no Visual Director, never
 * the image provider.
 */
export async function regenerateCarouselFromPrevious(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
  previousAsset: ContentAssetRow;
}): Promise<GenerateAssetOutcome> {
  const approved = approvedCarouselSlides(params.draft);
  if (!approved) return { status: "ineligible", message: "The approved carousel does not have a clean ordered set of slide texts." };
  const { plan: stored, cache } = storedCarouselPlan(params.previousAsset);
  const usable = stored && !carouselPlanShapeError(stored, approved.length) ? stored : null;
  return produceCarousel({
    db: params.db,
    storage: params.storage,
    draft: params.draft,
    nextVersion: params.nextVersion,
    approved,
    plan: usable ?? fallbackCarouselPlan(approved.length),
    origin: usable ? "reused_plan" : "fallback",
    fallbackReason: usable ? undefined : "No reusable carousel plan on the previous version — used the typographic fallback.",
    generativeCapabilityAvailable: true, // keeps generated slides' shape so cached sources can apply; no `paid` → the provider is never called
    cache,
  });
}

/** First carousel generation with no aiClient (dashboard without AI): typographic fallback plan, zero AI cost. */
export async function generateCarouselWithoutAi(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  draft: ContentDraftRow;
  nextVersion: number;
}): Promise<GenerateAssetOutcome> {
  const approved = approvedCarouselSlides(params.draft);
  if (!approved) return { status: "ineligible", message: "The approved carousel does not have a clean ordered set of slide texts." };
  return produceCarousel({
    ...params,
    approved,
    plan: fallbackCarouselPlan(approved.length),
    origin: "fallback",
    fallbackReason: "No AI client supplied — typographic carousel.",
    generativeCapabilityAvailable: false,
    cache: new Map(),
  });
}

