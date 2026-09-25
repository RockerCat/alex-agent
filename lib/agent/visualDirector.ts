import type { AiClient, VisualDirectorCallResult, CarouselVisualDirectorCallResult } from "@/lib/agent/aiClient";
import { VISUAL_STRATEGIES } from "@/lib/agent/schemas";
import type { RecentVisualHistory } from "@/lib/agent/visualHistory";

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

export interface GenerativeBudgetHint {
  /** Pre-call estimate for one generation at the fixed size/quality (lib/agent/imageGenerationClient.ts), or null if unknown. */
  approxCostUsd: number | null;
  /** Whether the current budget snapshot leaves room for `generations` generations this run. Informational — Budget Guard still decides before any paid call. */
  budgetPermits: boolean;
  /** How many generations `budgetPermits` was evaluated for (1 for a single image; the carousel cap for a carousel). Defaults to 1. */
  generations?: number;
}

export interface VisualDirectorContext {
  topic: string;
  purpose: string;
  audience: string;
  hook: string;
  ctaText: string;
  visualDirection: string;
  /** The draft's publishing channel (feed context for the history below). */
  channel: string;
  /** Concise, verified descriptions of what's actually available — never raw binary/PDF content. */
  availableVerifiedSources: string;
  generativeCapabilityAvailable: boolean;
  /** Only meaningful when generativeCapabilityAvailable. */
  generativeBudget: GenerativeBudgetHint;
  /** Carousel visual revision v1: generated imagery may only be reused, never newly generated. */
  generativeReuseOnly?: boolean;
  /** Compact deterministic history (see visualHistory.ts) — never raw provenance, URLs or binaries. */
  recentHistory: RecentVisualHistory;
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
  "Available strategies — each is a legitimate choice when it fits the draft:",
  "- product_ui: product evidence — the real SolarDesk interface (verifiedSourceCategory: product_screenshot).",
  "- proposal_document: document evidence — the real client-facing proposal PDF (verifiedSourceCategory: proposal_example).",
  "- branded_graphic: branded typography — a bold headline-led composition with no product or proposal imagery (verifiedSourceCategory: none); good for a single strong idea, a question, or educational content.",
  "- generated_photo: generated photographic/lifestyle imagery (installers on a roof or at a worksite, a homeowner conversation, an office moment) with brand chrome overlaid.",
  "- generated_illustration: a generated illustration (conceptual, abstract or explanatory imagery) with brand chrome overlaid.",
  "- hybrid: a generated contextual image combined with one piece of real verified evidence (product_screenshot or proposal_example).",
  "Generated photographic imagery is appropriate for conceptual, benefit-oriented, audience-oriented or human-context posts when it communicates the message better than another screenshot or document. Do not choose generated imagery merely for novelty, and do not default to generic solar-panel stock scenes.",
].join("\n");

const VARIETY_GUIDANCE = [
  "Visual variety (read the recent visual history in the user message):",
  "- Relevance to THIS approved draft is primary.",
  "- Variety still matters: followers see consecutive pieces in the same feed. Repeating the same strategy with the same source (e.g. the same proposal pages or the same screenshot) looks like the same creative even when the copy changes.",
  "- When another relevant strategy can communicate this draft's idea well, prefer a materially different treatment from the recent pieces — especially the latest published ones on this channel.",
  "- Repetition is allowed when the content genuinely requires it (e.g. the piece is specifically about showing the finished proposal). Do not rotate strategies mechanically.",
  "- Always fill varietyRationale: briefly state how your choice relates to the recent history (what it changes, or why repeating is right for this specific draft).",
].join("\n");

const STRATEGY_ORDER = VISUAL_STRATEGIES;

function formatHistory(history: RecentVisualHistory): string {
  if (history.entries.length === 0) return "(no SolarDesk visual history in this window yet)";
  const lines = history.entries.map((e, i) => {
    const concept = e.creativeConcept ? ` · concept="${e.creativeConcept}"` : "";
    const origin = e.strategySource === "legacy_inferred" ? " (inferred from renderer)" : "";
    return `${i + 1}. ${e.daysAgo}d ago · ${e.channel} · ${e.status} · ${e.strategy}${origin} · layout=${e.layout} theme=${e.theme ?? "?"} · source=${e.sourceFingerprint} · generatedImage=${e.generatedImage ? "yes" : "no"} · topic="${e.topic}"${concept}`;
  });
  const counts = STRATEGY_ORDER.map((st) => `${st}×${history.summary.strategyCounts[st] ?? 0}`).join(", ");
  const lastUse = STRATEGY_ORDER.map((st) => {
    const d = history.summary.daysSinceLastUse[st];
    return `${st} ${d === undefined ? "not used" : `${d}d`}`;
  }).join(", ");
  const sources = Object.entries(history.summary.sourceCounts)
    .map(([fp, n]) => `${fp}×${n}`)
    .join(", ");
  const published =
    history.summary.recentPublished.length > 0
      ? history.summary.recentPublished
          .map((p) => `${p.daysAgo}d ago ${p.channel}: ${p.strategy} / ${p.layout} / ${p.sourceFingerprint}${p.generatedImage ? " / generated image" : ""}`)
          .join("; ")
      : "(none published in this window)";
  return [
    ...lines,
    `Strategy counts: ${counts}`,
    `Days since last use: ${lastUse}`,
    `Source counts: ${sources}`,
    `Latest published feed treatments (newest first): ${published}`,
  ].join("\n");
}

function generativeLine(context: VisualDirectorContext): string {
  if (context.generativeReuseOnly) {
    return "Generated imagery is REUSE-ONLY this call: a generated_photo/generated_illustration slide is possible only by reusing a previously generated image (reuseGeneratedFromSlide); no new image will be generated, and a generated slide without a reusable image is rendered as branded_graphic.";
  }
  if (!context.generativeCapabilityAvailable) {
    return "Generative capability is NOT available this call — you must choose product_ui, proposal_document, or branded_graphic only. Never choose generated_photo, generated_illustration, or hybrid.";
  }
  const cost =
    context.generativeBudget.approxCostUsd !== null ? `approximately $${context.generativeBudget.approxCostUsd.toFixed(3)} per low-quality generation` : "cost per generation unknown";
  const n = context.generativeBudget.generations ?? 1;
  const budget = context.generativeBudget.budgetPermits
    ? n === 1
      ? "the current AI budget leaves room for one generation this run"
      : `the current AI budget leaves room for up to ${n} generations this run`
    : "the current AI budget does NOT leave room for a generation this run — a generated strategy would not execute and would fall back to branded_graphic";
  return `Generative capability IS available this call (${cost}; ${budget}). The Budget Guard makes the final decision before any paid image call; if it blocks, the piece falls back to branded_graphic.`;
}

export function buildVisualDirectorPrompt(context: VisualDirectorContext): { system: string; user: string } {
  const system = [
    "You are AlexAgent's Visual Director: you decide HOW an already-approved SolarDesk marketing post should be communicated visually, before any image is produced.",
    "Return a single bounded VisualCreativePlan. Evaluate the draft's actual communication goal — not just keyword matches — to choose the strategy that best fits THIS specific piece of content. Do not select proposal_document or product_ui merely because the text contains a related word (e.g. 'propuesta') if the goal is conceptual rather than showing the document/product itself.",
    BRAND_VISUAL_CONSTRAINTS,
    STRATEGY_GUIDANCE,
    VARIETY_GUIDANCE,
    generativeLine(context),
  ].join("\n");

  const user = [
    "=== Approved draft ===",
    `Channel: ${context.channel}`,
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
    `=== Recent SolarDesk visual history (last ${context.recentHistory.windowDays} days, one line per post, newest first) ===`,
    formatHistory(context.recentHistory),
  ].join("\n");

  return { system, user };
}

export interface CarouselVisualDirectorContext extends VisualDirectorContext {
  /** The approved slides, in order — each is rendered verbatim as that slide's text. */
  slides: { slideNumber: number; text: string }[];
  maxGeneratedSlides: number;
}

const CAROUSEL_GUIDANCE = [
  "You are planning ONE Instagram carousel: one editorial unit, one visual system, published as a single post.",
  "Return one carousel-level plan (creativeConcept, communicationGoal, renderSpec, rationale, varietyRationale) plus exactly one slidePlans entry per approved slide, in order, with slideNumber 1..N matching the slides listed.",
  "- One coherent creative concept and shared brand/art direction across all slides; deliberate progression from slide to slide (e.g. idea → evidence → result → call to action).",
  "- Enough visual variation between slides that they don't read as N identical cards, but never variety for its own sake — each slide's treatment must fit that slide's own text.",
  "- Per-slide strategies available in a carousel: branded_graphic, product_ui, proposal_document, generated_photo, generated_illustration. hybrid is NOT available inside a carousel.",
  "- Each slide's approved text is drawn on that slide exactly as written; the CTA button appears only on the last slide. You never add, remove, merge or reorder slides.",
  "- Set generativeSceneDescription only for generated_photo/generated_illustration slides (scene/style only, same rules as above); null for every other slide.",
  "Within the carousel:",
  "- Repeating a strategy is allowed when editorially useful, and repeated real evidence (e.g. the proposal) can be useful.",
  "- But two slides with the same strategy, the same source and the same view/composition read as duplicate creative. When you repeat proposal evidence, prefer a distinct verified proposal view (proposalFocus) that supports that slide's approved text — never force a view the text doesn't call for.",
  "- Relevance over novelty; no mechanical rotation.",
  "- If you deliberately keep an identical treatment on two slides, set intentionalRepeatOf on the later slide to the earlier slide's number and explain it in repetitionJustification; otherwise leave both null.",
  "- proposalFocus applies only to proposal_document slides (null for every other slide).",
];

/** The verified proposal views a proposal_document slide can show (lib/agent/proposalExamples.ts). */
const PROPOSAL_VIEW_GUIDANCE = [
  "Verified proposal views (proposalFocus, proposal_document slides only):",
  "- overview: the proposal's cover page as the main document, with the detail page behind it — the finished deliverable as a whole.",
  "- financial_detail: the real financial-analysis section — investment breakdown, savings projection, accumulated-savings and payback charts (example figures).",
  "- system_detail: the real system-design section — system power, panel count, area, monthly production and equipment (example figures).",
].join("\n");

export function buildCarouselVisualDirectorPrompt(context: CarouselVisualDirectorContext): { system: string; user: string } {
  const system = [
    "You are AlexAgent's Visual Director: you decide HOW an already-approved SolarDesk marketing post should be communicated visually, before any image is produced.",
    "Evaluate the carousel's actual communication goal — not just keyword matches. Do not select proposal_document or product_ui for a slide merely because its text contains a related word (e.g. 'propuesta') if that slide's point is conceptual rather than showing the document/product itself.",
    BRAND_VISUAL_CONSTRAINTS,
    STRATEGY_GUIDANCE,
    ...CAROUSEL_GUIDANCE,
    `- At most ${context.maxGeneratedSlides} slides may use generated imagery (generated_photo/generated_illustration); any beyond that are rendered as branded_graphic instead. Generated imagery is never required.`,
    PROPOSAL_VIEW_GUIDANCE,
    VARIETY_GUIDANCE,
    generativeLine(context),
  ].join("\n");

  const user = carouselDraftSection(context);
  return { system, user };
}

/** The approved content + sources + history block shared by the first-generation and revision carousel prompts. */
function carouselDraftSection(context: CarouselVisualDirectorContext): string {
  return [
    "=== Approved carousel draft ===",
    `Channel: ${context.channel}`,
    `Topic: ${context.topic}`,
    `Purpose: ${context.purpose}`,
    `Audience: ${context.audience}`,
    `Hook (context only — not rendered as a slide): ${context.hook}`,
    `CTA (last slide only): ${context.ctaText}`,
    `Approved visual direction: ${context.visualDirection || "(none)"}`,
    "",
    `=== Approved slides (${context.slides.length}, in publication order) ===`,
    ...context.slides.map((sl) => `${sl.slideNumber}. ${sl.text}`),
    "",
    "=== Available verified visual sources ===",
    context.availableVerifiedSources,
    "",
    `=== Recent SolarDesk visual history (last ${context.recentHistory.windowDays} days, one line per post, newest first) ===`,
    formatHistory(context.recentHistory),
  ].join("\n");
}

/** One slide of the carousel version being revised, as it was actually rendered. */
export interface PreviousCarouselSlide {
  slideNumber: number;
  strategy: string;
  proposalFocus: string | null;
  /** Canonical source identity actually shown (e.g. "proposal:…#p1+p2", "screenshot:04.png", "generated", "none"). */
  source: string;
  /** True when this slide's generated source image is cached and can be reused by reuseGeneratedFromSlide. */
  generatedImageAvailable: boolean;
  generativeSceneDescription: string | null;
}

export interface CarouselRevisionContext extends CarouselVisualDirectorContext {
  previousVersion: number;
  previousConcept: string;
  previousSlides: PreviousCarouselSlide[];
  /** Deterministic findings on the previous version (plain sentences). */
  previousFindings: string[];
  critique: string;
  /** Set only for the single corrective pass: the exact finding(s) still present in the first revised plan. */
  correctiveFindings?: string[];
}

const REVISION_GUIDANCE = [
  "This is a VISUAL REVISION of an already-rendered carousel whose content is approved and frozen.",
  "- Revise ONLY the visual plan. The approved slide texts, their order, the caption, the CTA and the hashtags cannot change — your output has no field for them.",
  "- Address the human critique. Keep treatments that worked (the previous plan and slide list are below) unless the critique or a finding requires changing them.",
  "- To keep a slide's existing generated image, set reuseGeneratedFromSlide to the previous slide number whose image you are keeping, keep the same generated strategy, and keep its scene description. Only slides marked \"generated image available\" can be reused.",
  "- This revision cannot create new generated images: a generated slide that doesn't reuse an available image will be rendered as branded_graphic instead. Never ask for new imagery merely for variety.",
  "- Use the verified proposal views to make repeated proposal evidence materially distinct where the approved text supports it.",
];

export function buildCarouselRevisionPrompt(context: CarouselRevisionContext): { system: string; user: string } {
  const base = buildCarouselVisualDirectorPrompt(context);
  const system = [base.system, ...REVISION_GUIDANCE].join("\n");
  const previous = context.previousSlides.map(
    (sl) =>
      `${sl.slideNumber}. ${sl.strategy}${sl.proposalFocus ? ` · view=${sl.proposalFocus}` : ""} · source=${sl.source}` +
      (sl.generatedImageAvailable ? " · generated image available" : "") +
      (sl.generativeSceneDescription ? ` · scene="${sl.generativeSceneDescription}"` : "")
  );
  const user = [
    carouselDraftSection(context),
    "",
    `=== Previous carousel version v${context.previousVersion} (as rendered) ===`,
    `Concept: ${context.previousConcept}`,
    ...previous,
    "",
    "=== Deterministic findings on the previous version ===",
    ...(context.previousFindings.length > 0 ? context.previousFindings : ["(none)"]),
    "",
    "=== Human critique (visual direction only) ===",
    context.critique,
    ...(context.correctiveFindings && context.correctiveFindings.length > 0
      ? [
          "",
          "=== Your previous revised plan still has these identical treatments ===",
          ...context.correctiveFindings,
          "Resolve them with a materially different treatment/view, or — only if the repetition is genuinely necessary — mark it with intentionalRepeatOf and repetitionJustification.",
        ]
      : []),
  ].join("\n");
  return { system, user };
}

export function estimateCarouselRevisionInputTokens(context: CarouselRevisionContext): number {
  const { system, user } = buildCarouselRevisionPrompt(context);
  return Math.ceil((system.length + user.length) / 4) + 50;
}

export async function callCarouselVisualRevision(aiClient: AiClient, context: CarouselRevisionContext): Promise<CarouselVisualDirectorCallResult> {
  const { system, user } = buildCarouselRevisionPrompt(context);
  return aiClient.runCarouselVisualRevision({ systemPrompt: system, userPrompt: user });
}

export function estimateCarouselVisualDirectorInputTokens(context: CarouselVisualDirectorContext): number {
  const { system, user } = buildCarouselVisualDirectorPrompt(context);
  return Math.ceil((system.length + user.length) / 4) + 50;
}

export async function callCarouselVisualDirector(aiClient: AiClient, context: CarouselVisualDirectorContext): Promise<CarouselVisualDirectorCallResult> {
  const { system, user } = buildCarouselVisualDirectorPrompt(context);
  return aiClient.runCarouselVisualDirector({ systemPrompt: system, userPrompt: user });
}

export async function callVisualDirector(aiClient: AiClient, context: VisualDirectorContext): Promise<VisualDirectorCallResult> {
  const { system, user } = buildVisualDirectorPrompt(context);
  return aiClient.runVisualDirector({ systemPrompt: system, userPrompt: user });
}

export function estimateVisualDirectorInputTokens(context: VisualDirectorContext): number {
  const { system, user } = buildVisualDirectorPrompt(context);
  return Math.ceil((system.length + user.length) / 4) + 50; // role/format scaffolding overhead
}
