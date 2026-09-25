import type { ContentDraftRow } from "@/lib/types/database";
import {
  CAROUSEL_MAX_GENERATED_SLIDES,
  CAROUSEL_MAX_SLIDES,
  DEFAULT_RENDER_SPEC,
  type CarouselSlidePlan,
  type CarouselVisualPlan,
  type VisualCreativePlan,
  type VisualStrategy,
} from "@/lib/agent/schemas";
import { resolveVisualSources, type DraftSelectionInput } from "@/lib/agent/visualSourceResolver";
import { slideTextFitsStrategy } from "@/lib/agent/assetRenderer";
import type { ScreenshotMeta } from "@/lib/agent/productScreenshots";
import type { ProposalExampleMeta } from "@/lib/agent/proposalExamples";

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
      slide = { ...slide, strategy: resolved.strategy, screenshotMeta: resolved.screenshotMeta, proposalMeta: resolved.proposalMeta };
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
