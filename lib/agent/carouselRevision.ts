import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ContentAssetRow, ContentDraftRow } from "@/lib/types/database";
import type { AssetStorage } from "@/lib/agent/assetStorage";
import type { AiClient, CarouselVisualDirectorCallResult } from "@/lib/agent/aiClient";
import { carouselVisualPlanSchema, CAROUSEL_MAX_GENERATED_SLIDES, type CarouselVisualPlan } from "@/lib/agent/schemas";
import { AVAILABLE_VERIFIED_SOURCES_SUMMARY, draftSelectionInput, getLatestAsset } from "@/lib/agent/assetGenerator";
import { carouselIneligibilityReason, produceCarousel } from "@/lib/agent/carouselGenerator";
import {
  approvedCarouselSlides,
  carouselPlanShapeError,
  findRepeatedTreatments,
  planCarouselSlides,
  type ApprovedCarouselSlide,
  type RepeatedTreatmentFinding,
} from "@/lib/agent/carouselPlan";
import { callCarouselVisualRevision, estimateCarouselRevisionInputTokens, type CarouselRevisionContext, type PreviousCarouselSlide } from "@/lib/agent/visualDirector";
import { describeAssetTreatment, getRecentVisualHistory } from "@/lib/agent/visualHistory";
import { resolveCtaLabelAndUrl } from "@/lib/agent/cta";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import { env } from "@/lib/env";
import { isUniqueViolation, recoverStaleRuns } from "@/lib/agent/runLock";

// Carousel visual revision v1. A human critique on a rendered carousel
// that is still pending review produces the NEXT carousel version with a
// revised VISUAL plan only — the approved content (slide texts/order,
// caption, CTA, hashtags, content version) is never touched: the revision
// output schema has no field that could carry any of it, and rendering
// always reads the approved draft.
//
// Paid calls: one revision Visual Director call, plus at most ONE
// corrective call when the revised plan still asks two slides for the
// identical visual treatment without declaring it intentional. ZERO image
// calls — generated imagery is reuse-only: a generated slide either
// reuses a previous version's cached source (explicit, validated
// reuseGeneratedFromSlide) or is deterministically downgraded to
// branded_graphic. The next version is rendered from scratch (all N
// slides, new theme/markers), the previous version is never modified, and
// the existing version guards make its approval email stale.

const MIN_CRITIQUE_LENGTH = 3;
const MAX_CRITIQUE_LENGTH = 800;
const REVISION_APPROX_OUTPUT_TOKENS = 2000;
export const CAROUSEL_REVISION_NO_NEW_IMAGES_REASON =
  "Carousel visual revision v1 is reuse-only: this generated slide had no reusable image from the previous version, so no new image was generated.";

export interface CarouselRevisionOutcome {
  status: "success" | "ineligible" | "failed" | "concurrent";
  asset?: ContentAssetRow;
  message?: string;
  budgetBlocked?: boolean;
  /** Visual Director calls made by this revision (1, or 2 with the corrective pass). */
  modelCalls?: number;
}

interface PreviousVersion {
  asset: ContentAssetRow;
  plan: CarouselVisualPlan;
  slides: (PreviousCarouselSlide & { storagePath: string | null })[];
  findings: string[];
}

/** Human-readable (for the prompt) statement of an identical-treatment finding. */
function describeRepeat(slides: number[], strategy: string, source: string): string {
  return `Slides ${slides.join(" and ")} show the identical treatment: ${strategy} · ${source}.`;
}
/** Same, from a treatment signature ("strategy|layout|source"). */
const describeFinding = (f: RepeatedTreatmentFinding) => {
  const [strategy, , ...source] = f.signature.split("|");
  return describeRepeat(f.slides, strategy, source.join("|"));
};

/** What the previous version actually rendered, per slide — from its durable provenance only. */
function readPreviousVersion(asset: ContentAssetRow): PreviousVersion | null {
  const provenance = (asset.render_provenance ?? {}) as Record<string, unknown>;
  const parsed = carouselVisualPlanSchema.safeParse(provenance.visualPlan);
  if (!parsed.success) return null;
  const rawSlides = Array.isArray(provenance.carouselSlides) ? (provenance.carouselSlides as Record<string, unknown>[]) : [];
  const slides = rawSlides.map((raw, i) => {
    const strategy = typeof raw.strategy === "string" ? raw.strategy : "branded_graphic";
    const generatedImage = (raw.generatedImage ?? {}) as { used?: unknown; storagePath?: unknown };
    const storagePath = generatedImage.used === true && typeof generatedImage.storagePath === "string" ? generatedImage.storagePath : null;
    const treatment = describeAssetTreatment({
      ...((raw.rendered as Record<string, unknown>) ?? {}),
      visualPlan: { strategy, origin: "visual_director", generatedImage: raw.generatedImage },
    });
    const focus = typeof raw.proposalFocus === "string" ? raw.proposalFocus : strategy === "proposal_document" ? "overview" : null;
    return {
      slideNumber: typeof raw.position === "number" ? raw.position : i + 1,
      strategy,
      proposalFocus: focus,
      source: treatment?.sourceFingerprint ?? "none",
      generatedImageAvailable: storagePath !== null,
      generativeSceneDescription: parsed.data.slidePlans[i]?.generativeSceneDescription ?? null,
      storagePath,
    };
  });
  // Findings on the previous version, from what it showed (verified source or the same reused image).
  const groups = new Map<string, { strategy: string; source: string; slides: number[] }>();
  for (const s of slides) {
    if (s.source === "none" || s.source === "generated") continue;
    const key = `${s.strategy}|${s.source}`;
    const group = groups.get(key) ?? { strategy: s.strategy, source: s.source, slides: [] };
    group.slides.push(s.slideNumber);
    groups.set(key, group);
  }
  const findings = [...groups.values()].filter((g) => g.slides.length > 1).map((g) => describeRepeat(g.slides, g.strategy, g.source));
  return { asset, plan: parsed.data, slides, findings };
}

interface ReuseDecision {
  slide: number;
  fromSlide: number;
  accepted: boolean;
  reason?: string;
}

/**
 * Validates every reuseGeneratedFromSlide request against the previous
 * version: accepted only when that previous slide really used a cached
 * generated source and the revised slide keeps the SAME generated
 * strategy (unchanged generative intent). An accepted reuse carries the
 * previous scene description into the revised plan (it describes the
 * image actually shown) and maps the cached source to this slide.
 */
function applyReuse(plan: CarouselVisualPlan, previous: PreviousVersion): { plan: CarouselVisualPlan; cache: Map<number, string>; decisions: ReuseDecision[] } {
  const cache = new Map<number, string>();
  const decisions: ReuseDecision[] = [];
  const slidePlans = plan.slidePlans.map((sp) => {
    const from = sp.reuseGeneratedFromSlide ?? null;
    if (from === null) return sp;
    const source = previous.slides.find((s) => s.slideNumber === from);
    let reason: string | undefined;
    if (!source || !source.storagePath) reason = `previous slide ${from} has no cached generated image`;
    else if (sp.strategy !== "generated_photo" && sp.strategy !== "generated_illustration") reason = `slide ${sp.slideNumber} is no longer a generated slide`;
    else if (sp.strategy !== source.strategy) reason = `slide ${sp.slideNumber} changed the generated strategy (${source.strategy} → ${sp.strategy})`;
    if (reason) {
      decisions.push({ slide: sp.slideNumber, fromSlide: from, accepted: false, reason });
      return { ...sp, reuseGeneratedFromSlide: null };
    }
    cache.set(sp.slideNumber, source!.storagePath!);
    decisions.push({ slide: sp.slideNumber, fromSlide: from, accepted: true });
    return { ...sp, generativeSceneDescription: source!.generativeSceneDescription ?? sp.generativeSceneDescription };
  });
  return { plan: { ...plan, slidePlans }, cache, decisions };
}

/** Deterministic unjustified repeat findings for a revised plan, exactly as it would render under the reuse-only policy. */
function unjustifiedRepeats(
  plan: CarouselVisualPlan,
  approved: ApprovedCarouselSlide[],
  draft: ContentDraftRow,
  cache: Map<number, string>
): { findings: RepeatedTreatmentFinding[]; planningError?: string } {
  const planning = planCarouselSlides(plan, approved, draftSelectionInput(draft), { generativeCapabilityAvailable: true });
  if (!planning.ok) return { findings: [], planningError: planning.reason };
  // Reuse-only: a generated slide without a cached source will render as typography (no visual material).
  const final = planning.slides.map((s) => (s.needsGeneratedImage && !cache.has(s.position) ? { ...s, strategy: "branded_graphic" as const, proposalMeta: null, screenshotMeta: null, proposalFocus: null } : s));
  return { findings: findRepeatedTreatments(final, plan.renderSpec, plan.repetitionJustification, cache).filter((f) => !f.justified) };
}

/** Eligibility shared by the action and the dashboard card. Null when a visual revision may be requested. */
export async function carouselRevisionIneligibilityReason(db: SupabaseClient<Database>, draft: ContentDraftRow): Promise<string | null> {
  if (draft.brand !== "solardesk") return "Carousel visual revision is only supported for SolarDesk.";
  if (draft.status !== "approved") return `Draft is "${draft.status}" — only approved content can have its carousel visuals revised.`;
  if (draft.content_type !== "carousel") return "Only carousels support visual revision.";
  const carouselReason = carouselIneligibilityReason(draft);
  if (carouselReason) return carouselReason;
  if (!draft.hook || !draft.cta_text) return "The approved draft lacks the hook/CTA text needed to render.";
  const latest = await getLatestAsset(db, draft.id);
  if (!latest || latest.format !== "carousel") return "There is no rendered carousel to revise yet.";
  if (latest.status !== "pending_review") return `The latest carousel version is "${latest.status}" — only a carousel pending review can be revised.`;
  if (latest.source_draft_version !== draft.version) return "The latest carousel was rendered from a different content version.";
  const { data: publications } = await db.from("asset_publications").select("id").eq("asset_id", latest.id);
  if ((publications ?? []).length > 0) return "This carousel already has a publication attempt.";
  const { data: approvals } = await db.from("email_action_tokens").select("id").eq("action", "approve_asset").eq("subject_id", latest.id).eq("outcome", "applied");
  if ((approvals ?? []).length > 0) return "This carousel version was already approved for publication.";
  return null;
}

/**
 * Manual-only entry point (dashboard "request visual changes"). Never
 * called by the wake, the sweeps or any email action. Brand-locked like
 * every other paid operation.
 */
export async function requestCarouselVisualRevision(params: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  aiClient: AiClient;
  draftId: string;
  critique: string;
}): Promise<CarouselRevisionOutcome> {
  const { db, storage, aiClient, draftId } = params;
  const critique = params.critique.trim();
  if (critique.length < MIN_CRITIQUE_LENGTH) return { status: "ineligible", message: "Describe the visual change you want." };
  if (critique.length > MAX_CRITIQUE_LENGTH) return { status: "ineligible", message: `The critique is too long (max ${MAX_CRITIQUE_LENGTH} characters).` };

  const { data: draft } = await db.from("content_drafts").select("*").eq("id", draftId).maybeSingle();
  if (!draft) return { status: "ineligible", message: "Draft not found." };
  const ineligible = await carouselRevisionIneligibilityReason(db, draft);
  if (ineligible) return { status: "ineligible", message: ineligible };
  const approved = approvedCarouselSlides(draft)!;

  await recoverStaleRuns(db, draft.brand);
  const { data: lockRun, error: lockError } = await db
    .from("agent_runs")
    .insert({ brand: draft.brand, trigger: "manual", kind: "revision", status: "running" })
    .select("*")
    .single();
  if (lockError || !lockRun) {
    if (isUniqueViolation(lockError)) return { status: "concurrent", message: "Another SolarDesk agent operation is already running." };
    return { status: "failed", message: lockError?.message ?? "Could not start the revision." };
  }
  const finish = async (status: "completed" | "failed" | "skipped", summary: string, extra: Record<string, unknown> = {}) => {
    await db.from("agent_runs").update({ status, summary, completed_at: new Date().toISOString(), ...extra }).eq("id", lockRun.id);
  };

  try {
    const outcome = await reviseUnderLock({ db, storage, aiClient, draft, approved, critique, agentRunId: lockRun.id });
    if (outcome.budgetBlocked) await finish("skipped", outcome.message ?? "Budget blocked.", { decision: "BUDGET_BLOCKED" });
    else if (outcome.status === "success") await finish("completed", `Created carousel visual revision v${outcome.asset!.asset_version} (${outcome.modelCalls} Visual Director call(s), 0 image calls).`);
    else await finish("failed", outcome.message ?? "Carousel visual revision failed.", { error_code: "carousel_revision_failed", error_message: outcome.message ?? "unknown" });
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish("failed", message, { error_code: "carousel_revision_failed", error_message: message });
    return { status: "failed", message };
  }
}

async function reviseUnderLock(p: {
  db: SupabaseClient<Database>;
  storage: AssetStorage;
  aiClient: AiClient;
  draft: ContentDraftRow;
  approved: ApprovedCarouselSlide[];
  critique: string;
  agentRunId: string;
}): Promise<CarouselRevisionOutcome> {
  const { db, storage, aiClient, draft, approved, critique, agentRunId } = p;
  // Re-read under the lock: the version being revised must still be the latest.
  const latest = await getLatestAsset(db, draft.id);
  if (!latest || latest.format !== "carousel" || latest.status !== "pending_review") {
    return { status: "concurrent", message: "The carousel changed while starting the revision. Please try again." };
  }
  const previous = readPreviousVersion(latest);
  if (!previous || carouselPlanShapeError(previous.plan, approved.length)) {
    return { status: "ineligible", message: "The current carousel version has no reusable visual plan to revise." };
  }

  const budgetGuard = new BudgetGuard(db);
  const history = await getRecentVisualHistory(db, draft.brand);
  const context: CarouselRevisionContext = {
    topic: draft.topic,
    purpose: draft.purpose,
    audience: draft.audience,
    hook: draft.hook!,
    ctaText: resolveCtaLabelAndUrl(draft).label,
    visualDirection: draft.visual_direction ?? "",
    channel: draft.channel,
    availableVerifiedSources: AVAILABLE_VERIFIED_SOURCES_SUMMARY,
    generativeCapabilityAvailable: true,
    generativeReuseOnly: true,
    generativeBudget: { approxCostUsd: null, budgetPermits: false },
    recentHistory: history,
    slides: approved.map((s) => ({ slideNumber: s.position, text: s.text })),
    maxGeneratedSlides: CAROUSEL_MAX_GENERATED_SLIDES,
    previousVersion: latest.asset_version,
    previousConcept: previous.plan.creativeConcept,
    previousSlides: previous.slides.map((s) => ({
      slideNumber: s.slideNumber,
      strategy: s.strategy,
      proposalFocus: s.proposalFocus,
      source: s.source,
      generatedImageAvailable: s.generatedImageAvailable,
      generativeSceneDescription: s.generativeSceneDescription,
    })),
    previousFindings: previous.findings,
    critique,
  };

  let modelCalls = 0;
  const call = async (ctx: CarouselRevisionContext): Promise<{ plan?: CarouselVisualPlan; error?: string; budgetBlocked?: string }> => {
    const check = await budgetGuard.checkBeforeCall({
      agentRunId,
      model: env.executorModel(),
      approxInputTokens: estimateCarouselRevisionInputTokens(ctx),
      approxMaxOutputTokens: REVISION_APPROX_OUTPUT_TOKENS,
    });
    if (!check.allowed) return { budgetBlocked: check.reason };
    modelCalls += 1;
    let result: CarouselVisualDirectorCallResult;
    try {
      result = await callCarouselVisualRevision(aiClient, ctx);
    } catch (err) {
      return { error: `Carousel visual revision call failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    await budgetGuard.recordUsage({ agentRunId, brand: draft.brand, operation: "executor", model: result.model, usage: result.usage });
    if (result.incomplete || !result.output) return { error: "The carousel visual revision response was incomplete." };
    const shapeError = carouselPlanShapeError(result.output, approved.length);
    if (shapeError) return { error: shapeError };
    return { plan: result.output };
  };

  const first = await call(context);
  if (first.budgetBlocked) return { status: "failed", budgetBlocked: true, message: first.budgetBlocked, modelCalls };
  if (!first.plan) return { status: "failed", message: first.error, modelCalls };

  let revised = applyReuse(first.plan, previous);
  let repeats = unjustifiedRepeats(revised.plan, approved, draft, revised.cache);
  if (repeats.planningError) return { status: "failed", message: repeats.planningError, modelCalls };
  const initialRepeats = repeats.findings;
  let correctivePass = false;

  if (repeats.findings.length > 0) {
    // At most ONE corrective pass, with the exact structured finding. Never a loop, never a mechanical rewrite.
    correctivePass = true;
    const second = await call({ ...context, correctiveFindings: repeats.findings.map(describeFinding) });
    if (second.plan) {
      const candidate = applyReuse(second.plan, previous);
      const candidateRepeats = unjustifiedRepeats(candidate.plan, approved, draft, candidate.cache);
      if (!candidateRepeats.planningError) {
        revised = candidate;
        repeats = candidateRepeats;
      }
    }
  }

  const outcome = await produceCarousel({
    db,
    storage,
    draft,
    nextVersion: latest.asset_version + 1,
    approved,
    plan: revised.plan,
    origin: "revision",
    generativeCapabilityAvailable: true, // keeps generated slides' shape so accepted reuse applies; no `paid` → the provider is never called
    varietyHistory: history,
    cache: revised.cache,
    noCacheReason: CAROUSEL_REVISION_NO_NEW_IMAGES_REASON,
    extraPlanProvenance: {
      revision: {
        fromAssetId: latest.id,
        fromVersion: latest.asset_version,
        critique,
        modelCalls,
        imageCalls: 0,
        correctivePass,
        initialRepeats,
        reuse: revised.decisions,
      },
    },
  });
  if (outcome.status !== "success") return { status: outcome.status, message: outcome.message, modelCalls };
  return { status: "success", asset: outcome.asset, modelCalls };
}
