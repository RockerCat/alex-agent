import type { AiClient, VisualDirectorCallResult } from "@/lib/agent/aiClient";
import type { VisualStrategy } from "@/lib/agent/schemas";

// AlexAgent v0.2 — Visual Director (spec: "Prompt Master — Visual
// Creative Direction + Generative Visuals"). Narrow creative-planning
// task: turn an approved draft's own fields into a bounded
// VisualCreativePlan (lib/agent/schemas.ts) BEFORE any pixel production
// happens. Uses the same Executor model/configuration as the asset
// feedback interpreter (lib/agent/assetFeedbackInterpreter.ts) — no
// reasoning effort, exactly one structured-output call. This module
// never renders pixels and never resolves a plan's verified-source
// category to a real catalog file itself — that stays the job of
// lib/agent/assetGenerator.ts's resolver, so a model output can never
// reach a filesystem path directly.

export interface RecentAssetStrategyEntry {
  topic: string;
  purpose: string;
  strategy: VisualStrategy;
  creativeConcept: string;
}

export interface VisualDirectorContext {
  topic: string;
  purpose: string;
  audience: string;
  hook: string;
  ctaText: string;
  visualDirection: string;
  /** Concise, verified descriptions of what's actually available — never raw binary/PDF content. */
  availableVerifiedSources: string;
  generativeCapabilityAvailable: boolean;
  /** Bounded (see visualHistory.ts) — never full historical binaries, only strategy/concept/topic/purpose text. */
  recentHistory: RecentAssetStrategyEntry[];
}

const BRAND_VISUAL_CONSTRAINTS = [
  "SolarDesk's brand colors are fixed: navy #0F172A (primary), amber #F59E0B (accent), white, light gray. You are not choosing colors, fonts, or coordinates.",
  "The official logo, real product screenshots, and the real proposal-example PDF pages are fixed, verified assets. You may request a verified-source CATEGORY (product_screenshot, proposal_example, or none) — never a specific file, path, or new asset. The application resolves the actual file.",
  "The official logo must never be reproduced/approximated by generative imagery — it is always composited from the real file regardless of strategy.",
  "Real product UI and the real proposal document must never be reproduced/approximated by generative imagery — when you want to show either, choose verifiedSourceCategory accordingly (product_ui/proposal_document strategies, or hybrid) rather than describing them in generativeSceneDescription.",
  "generativeSceneDescription (only used for generated_photo/generated_illustration/hybrid) must describe a visual scene/style/composition only — installers, homeowners, solar panels/installations, offices, environmental or abstract/conceptual imagery. It must never describe SolarDesk's UI, logo, pricing, metrics, testimonials, or any factual claim.",
  "renderSpec reuses the same five-field bounded rendering schema Request Changes already validates against (primaryVisualScale, ctaEmphasis, logoEmphasis, secondaryPageVisibility, disclosureEmphasis) — choose values appropriate for a first-time render of this draft; secondaryPageVisibility/disclosureEmphasis only matter when a proposal document is shown.",
  "You decide visual hierarchy/emphasis only through renderSpec and compositionIntent — you never rewrite, shorten, or add to the approved hook/CTA text; those fields don't exist in your output schema.",
].join("\n");

const STRATEGY_GUIDANCE = [
  "Available strategies:",
  "- product_ui: show the real SolarDesk product interface (verifiedSourceCategory: product_screenshot).",
  "- proposal_document: show the real client-facing proposal PDF output (verifiedSourceCategory: proposal_example).",
  "- branded_graphic: a general branded graphic/text composition with no product or proposal imagery (verifiedSourceCategory: none) — good for conceptual/educational content that isn't about demonstrating the product or a document.",
  "- generated_photo / generated_illustration: a generated supporting image (people, installations, environments, abstract/conceptual imagery) as the visual, with brand chrome (logo/headline/CTA) overlaid — only choose these if generative capability is available.",
  "- hybrid: a generated supporting image combined with one piece of real verified material (product_screenshot or proposal_example) — only choose this if generative capability is available.",
  "Relevance always wins over forced novelty: repeating a strategy is correct when it is still the best fit for this specific draft's topic/purpose. Do not select proposal_document or product_ui merely because the topic contains a related word (e.g. 'propuesta') if the draft's actual communication goal is conceptual rather than about showing the document/product itself — and conversely, do not avoid repeating a strategy just to appear different when it remains the right fit.",
].join("\n");

export function buildVisualDirectorPrompt(context: VisualDirectorContext): { system: string; user: string } {
  const system = [
    "You are AlexAgent's Visual Director: you decide HOW an already-approved SolarDesk marketing post should be communicated visually, before any image is produced.",
    "Return a single bounded VisualCreativePlan. Evaluate the draft's actual communication goal — not just keyword matches — to choose the strategy that best fits THIS specific piece of content.",
    BRAND_VISUAL_CONSTRAINTS,
    STRATEGY_GUIDANCE,
    context.generativeCapabilityAvailable
      ? "Generative capability IS available this call."
      : "Generative capability is NOT available this call — you must choose product_ui, proposal_document, or branded_graphic only. Never choose generated_photo, generated_illustration, or hybrid.",
  ].join("\n");

  const historyLines =
    context.recentHistory.length > 0
      ? context.recentHistory
          .map((h, i) => `${i + 1}. topic="${h.topic}" purpose="${h.purpose}" -> strategy=${h.strategy}, concept="${h.creativeConcept}"`)
          .join("\n")
      : "(no recent asset history yet)";

  const user = [
    "=== Approved draft ===",
    `Topic: ${context.topic}`,
    `Purpose: ${context.purpose}`,
    `Audience: ${context.audience}`,
    `Hook: ${context.hook}`,
    `CTA: ${context.ctaText}`,
    `Approved visual direction: ${context.visualDirection || "(none)"}`,
    "",
    "=== Available verified visual sources ===",
    context.availableVerifiedSources,
    "",
    "=== Recent asset strategy history (most recent first, for avoiding mindless repetition — relevance still wins) ===",
    historyLines,
  ].join("\n");

  return { system, user };
}

export async function callVisualDirector(aiClient: AiClient, context: VisualDirectorContext): Promise<VisualDirectorCallResult> {
  const { system, user } = buildVisualDirectorPrompt(context);
  return aiClient.runVisualDirector({ systemPrompt: system, userPrompt: user });
}

export function estimateVisualDirectorInputTokens(context: VisualDirectorContext): number {
  const historyChars = context.recentHistory.reduce(
    (sum, h) => sum + h.topic.length + h.purpose.length + h.strategy.length + h.creativeConcept.length + 20,
    0
  );
  const approxChars =
    BRAND_VISUAL_CONSTRAINTS.length +
    STRATEGY_GUIDANCE.length +
    context.topic.length +
    context.purpose.length +
    context.audience.length +
    context.hook.length +
    context.ctaText.length +
    context.visualDirection.length +
    context.availableVerifiedSources.length +
    historyChars +
    500; // system/user scaffolding overhead
  return Math.ceil(approxChars / 4);
}
