import type { ContentDraftRow } from "@/lib/types/database";
import {
  CAROUSEL_MAX_GENERATED_SLIDES,
  CAROUSEL_MAX_SLIDES,
  DEFAULT_RENDER_SPEC,
  type AssetRenderSpec,
  type CarouselSlidePlan,
  type ProposalFocusView,
  type CarouselVisualPlan,
  type VisualCreativePlan,
  type VisualStrategy,
} from "@/lib/agent/schemas";
import { resolveVisualSources, type DraftSelectionInput } from "@/lib/agent/visualSourceResolver";
import { slideTextFitsStrategy } from "@/lib/agent/assetRenderer";
import type { ScreenshotMeta } from "@/lib/agent/productScreenshots";
import { PROPOSAL_FOCUS_REGIONS, type ProposalExampleMeta } from "@/lib/agent/proposalExamples";
import { proposalSourceFingerprint, screenshotSourceFingerprint } from "@/lib/agent/visualHistory";

// Instagram carousel v1 — pure, deterministic planning. The carousel
// Visual Director proposes ONE carousel-level plan with ordered
// slidePlans; everything that must never be trusted from a model
// (slide count/order, the generated-slide cap, text fit, source
// resolution against the real catalogs) is decided here, in code, before
// any paid image call. No I/O.

export interface ApprovedCarouselSlide {
  position: number;
  text: string;
}

/**
 * The approved slides of a carousel draft in publication order, or null
 * when they aren't a clean 1..N sequence of non-empty texts. N approved
 * slides always become exactly N images — no cover/hook slide is added.
 */
export function approvedCarouselSlides(draft: Pick<ContentDraftRow, "body">): ApprovedCarouselSlide[] | null {
  const raw = (draft.body as { slides?: unknown } | null)?.slides;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CAROUSEL_MAX_SLIDES) return null;
  const slides: ApprovedCarouselSlide[] = [];
  for (const item of raw) {
    const slide = (item as { slide?: unknown })?.slide;
    const text = (item as { text?: unknown })?.text;
    if (typeof slide !== "number" || !Number.isInteger(slide) || typeof text !== "string" || !text.trim()) return null;
    slides.push({ position: slide, text: text.trim() });
  }
  slides.sort((a, b) => a.position - b.position);
  return slides.every((s, i) => s.position === i + 1) ? slides : null;
}

/** Null when the model's slidePlans exactly cover slides 1..N in order; otherwise the reason the WHOLE plan is unusable. */
export function carouselPlanShapeError(plan: CarouselVisualPlan, slideCount: number): string | null {
  if (plan.slidePlans.length !== slideCount) {
    return `Visual Director returned ${plan.slidePlans.length} slide plans for a ${slideCount}-slide carousel.`;
  }
  const outOfOrder = plan.slidePlans.findIndex((sp, i) => sp.slideNumber !== i + 1);
  if (outOfOrder !== -1) {
    return `Visual Director slide plans are not numbered 1..${slideCount} in order (position ${outOfOrder + 1} has slideNumber ${plan.slidePlans[outOfOrder].slideNumber}).`;
  }
  return null;
}

/** Safe whole-carousel fallback (Visual Director unavailable, failed, or unusable): every slide a branded typographic card. */
export function fallbackCarouselPlan(slideCount: number): CarouselVisualPlan {
  return {
    creativeConcept: "Carrusel tipográfico de marca (Visual Director no disponible).",
    communicationGoal: "Comunicar el contenido aprobado de cada diapositiva.",
    renderSpec: DEFAULT_RENDER_SPEC,
    rationale: "Se usó la composición tipográfica de marca para todas las diapositivas porque el Visual Director no está disponible o su plan no era utilizable.",
    slidePlans: Array.from({ length: slideCount }, (_, i) => ({
      slideNumber: i + 1,
      strategy: "branded_graphic" as const,
      verifiedSourceCategory: "none" as const,
      compositionIntent: "graphic_text_dominant" as const,
      generativeSceneDescription: null,
    })),
  };
}

/** A single slide expressed as an ordinary VisualCreativePlan, so the existing resolver/prompt builder/renderer apply unchanged. */
export function slideAsVisualPlan(plan: CarouselVisualPlan, slidePlan: CarouselSlidePlan): VisualCreativePlan {
  return {
    strategy: slidePlan.strategy,
    creativeConcept: plan.creativeConcept,
    communicationGoal: plan.communicationGoal,
    verifiedSourceCategory: slidePlan.verifiedSourceCategory,
    generativeSceneDescription: slidePlan.generativeSceneDescription,
    compositionIntent: slidePlan.compositionIntent,
    renderSpec: plan.renderSpec,
    rationale: plan.rationale,
  };
}

const isGenerated = (s: VisualStrategy) => s === "generated_photo" || s === "generated_illustration";

export interface PlannedCarouselSlide {
  position: number;
  text: string;
  requestedStrategy: VisualStrategy;
  /** Final strategy after deterministic checks. A generated slide can still be downgraded later if its (paid) generation doesn't happen. */
  strategy: VisualStrategy;
  slidePlan: VisualCreativePlan;
  screenshotMeta: ScreenshotMeta | null;
  proposalMeta: ProposalExampleMeta | null;
  /** The verified proposal view this slide shows — set only while the final strategy is proposal_document ("overview" when the plan didn't say). */
  proposalFocus: ProposalFocusView | null;
  /** The earlier slide this one deliberately repeats, as declared by the Visual Director. */
  intentionalRepeatOf: number | null;
  needsGeneratedImage: boolean;
  degradeReasons: string[];
}

export type CarouselSlidePlanning = { ok: true; slides: PlannedCarouselSlide[] } | { ok: false; reason: string };

function toBranded(slide: PlannedCarouselSlide, reason: string): PlannedCarouselSlide {
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
 * Deterministically turns a (shape-valid) carousel plan into renderable
 * slides, in order:
 *   1. generated slides need capability and a scene description;
 *   2. verified sources resolve against the real catalogs (unresolvable → branded_graphic);
 *   3. each slide's approved text must fit its layout (else branded_graphic,
 *      the highest-capacity text layout); if even that doesn't fit, the
 *      whole carousel fails — before any paid call, never truncated;
 *   4. at most `maxGenerated` generated slides, first-come in slide order;
 *      any beyond are downgraded to branded_graphic.
 * Every downgrade is recorded on its slide.
 */
export function planCarouselSlides(
  plan: CarouselVisualPlan,
  approved: ApprovedCarouselSlide[],
  selection: DraftSelectionInput,
  options: { generativeCapabilityAvailable: boolean; maxGenerated?: number }
): CarouselSlidePlanning {
  const maxGenerated = options.maxGenerated ?? CAROUSEL_MAX_GENERATED_SLIDES;
  const planned: PlannedCarouselSlide[] = [];
  let generatedCount = 0;

  for (const [i, slidePlan] of plan.slidePlans.entries()) {
    const { position, text } = approved[i];
    let slide: PlannedCarouselSlide = {
      position,
      text,
      requestedStrategy: slidePlan.strategy,
      strategy: slidePlan.strategy,
      slidePlan: slideAsVisualPlan(plan, slidePlan),
      screenshotMeta: null,
      proposalMeta: null,
      proposalFocus: null,
      intentionalRepeatOf: slidePlan.intentionalRepeatOf ?? null,
      needsGeneratedImage: false,
      degradeReasons: [],
    };

    if (isGenerated(slide.strategy) && !options.generativeCapabilityAvailable) {
      slide = toBranded(slide, "Generative imagery capability is not available.");
    } else if (isGenerated(slide.strategy) && !slidePlan.generativeSceneDescription) {
      slide = toBranded(slide, "Generated slide had no scene description.");
    }

    if (!isGenerated(slide.strategy)) {
      const resolved = resolveVisualSources({ ...slide.slidePlan, strategy: slide.strategy }, selection, false);
      slide = {
        ...slide,
        strategy: resolved.strategy,
        screenshotMeta: resolved.screenshotMeta,
        proposalMeta: resolved.proposalMeta,
        proposalFocus: resolved.strategy === "proposal_document" ? (slidePlan.proposalFocus ?? "overview") : null,
      };
      if (resolved.degraded && resolved.degradeReason) slide.degradeReasons = [...slide.degradeReasons, resolved.degradeReason];
    }

    if (slide.strategy !== "branded_graphic" && !slideTextFitsStrategy(text, slide.strategy)) {
      slide = toBranded(slide, `Approved slide text does not fit the ${slide.strategy} layout.`);
    }
    if (!slideTextFitsStrategy(text, "branded_graphic")) {
      return { ok: false, reason: `The approved text of slide ${position} is too long to render safely on a carousel slide without truncating it.` };
    }

    if (isGenerated(slide.strategy)) {
      generatedCount += 1;
      if (generatedCount > maxGenerated) {
        slide = toBranded(slide, `Carousel v1 allows at most ${maxGenerated} generated slides.`);
      } else {
        slide = { ...slide, needsGeneratedImage: true };
      }
    }
    planned.push(slide);
  }
  return { ok: true, slides: planned };
}

/** The carousel's dominant treatment for visual history: its most frequent final slide strategy (ties → earliest slide). */
export function dominantStrategy(strategies: VisualStrategy[]): VisualStrategy {
  const counts = new Map<VisualStrategy, number>();
  for (const s of strategies) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = strategies[0];
  for (const s of strategies) if ((counts.get(s) ?? 0) > (counts.get(best) ?? 0)) best = s;
  return best;
}

// ---------------------------------------------------------------------
// Intra-carousel treatment signatures (carousel visual revision v1).
// Structured metadata only — no image similarity. Two slides "request
// the same visual treatment" when they would show the same real visual
// material through the same layout: the same strategy + layout + source
// view (a verified proposal view or screenshot), or the same reused
// generated image. Repeating a strategy, or even the same document
// through a DIFFERENT verified view, is not a finding. Sourceless
// typographic slides are never findings: their approved text IS their
// visual content.
// ---------------------------------------------------------------------

const LAYOUT_BY_STRATEGY: Record<string, string> = {
  branded_graphic: "text_only",
  product_ui: "product",
  proposal_document: "proposal",
  generated_photo: "hero",
  generated_illustration: "hero",
  hybrid: "hero",
};

/**
 * The slide's treatment signature, or null when it shows no reusable
 * visual material (typography only, or a newly generated image that is
 * unique by construction). `reusedSourcePath` is the cached generated
 * source this slide will composite, if any.
 */
export function slideTreatmentSignature(slide: PlannedCarouselSlide, spec: AssetRenderSpec, reusedSourcePath?: string | null): string | null {
  const layout = LAYOUT_BY_STRATEGY[slide.strategy] ?? slide.strategy;
  if (slide.strategy === "proposal_document" && slide.proposalMeta) {
    const view = slide.proposalFocus ?? "overview";
    const pages =
      view === "overview"
        ? (spec.secondaryPageVisibility === "hidden" ? slide.proposalMeta.pages.slice(0, 1) : slide.proposalMeta.pages).map((p) => p.file)
        : [slide.proposalMeta.pages[PROPOSAL_FOCUS_REGIONS[view].pageIndex].file];
    return `${slide.strategy}|${layout}|${proposalSourceFingerprint(slide.proposalMeta.pdfPath, pages, view)}`;
  }
  if (slide.strategy === "product_ui" && slide.screenshotMeta) {
    return `${slide.strategy}|${layout}|${screenshotSourceFingerprint(slide.screenshotMeta.file)}`;
  }
  if ((slide.strategy === "generated_photo" || slide.strategy === "generated_illustration") && reusedSourcePath) {
    return `${slide.strategy}|${layout}|generated:${reusedSourcePath}`;
  }
  return null;
}

export interface RepeatedTreatmentFinding {
  /** Slide positions (ascending) that request the identical treatment. */
  slides: number[];
  signature: string;
  /** True only when every later slide declares intentionalRepeatOf an earlier one in the group AND the plan gives a repetitionJustification. */
  justified: boolean;
}

/** Groups of ≥2 slides with the same treatment signature (see slideTreatmentSignature). Deterministic, slide order. */
export function findRepeatedTreatments(
  slides: PlannedCarouselSlide[],
  spec: AssetRenderSpec,
  repetitionJustification: string | null | undefined,
  reusedSources: Map<number, string> = new Map()
): RepeatedTreatmentFinding[] {
  const groups = new Map<string, PlannedCarouselSlide[]>();
  for (const slide of slides) {
    const signature = slideTreatmentSignature(slide, spec, reusedSources.get(slide.position));
    if (!signature) continue;
    groups.set(signature, [...(groups.get(signature) ?? []), slide]);
  }
  const hasJustification = !!repetitionJustification && repetitionJustification.trim().length > 0;
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([signature, members]) => {
      const positions = members.map((m) => m.position);
      const declared = members.slice(1).every((m) => m.intentionalRepeatOf !== null && positions.includes(m.intentionalRepeatOf) && m.intentionalRepeatOf < m.position);
      return { slides: positions, signature, justified: hasJustification && declared };
    });
}
