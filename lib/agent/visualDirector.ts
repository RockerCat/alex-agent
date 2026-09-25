import type { AiClient, VisualDirectorCallResult } from "@/lib/agent/aiClient";
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
  /** Whether the current budget snapshot leaves room for one generation this run. Informational — Budget Guard still decides before any paid call. */
  budgetPermits: boolean;
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
  if (!context.generativeCapabilityAvailable) {
    return "Generative capability is NOT available this call — you must choose product_ui, proposal_document, or branded_graphic only. Never choose generated_photo, generated_illustration, or hybrid.";
  }
  const cost =
    context.generativeBudget.approxCostUsd !== null ? `approximately $${context.generativeBudget.approxCostUsd.toFixed(3)} per low-quality generation` : "cost per generation unknown";
  const budget = context.generativeBudget.budgetPermits
    ? "the current AI budget leaves room for one generation this run"
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

export async function callVisualDirector(aiClient: AiClient, context: VisualDirectorContext): Promise<VisualDirectorCallResult> {
  const { system, user } = buildVisualDirectorPrompt(context);
  return aiClient.runVisualDirector({ systemPrompt: system, userPrompt: user });
}

export function estimateVisualDirectorInputTokens(context: VisualDirectorContext): number {
  const { system, user } = buildVisualDirectorPrompt(context);
  return Math.ceil((system.length + user.length) / 4) + 50; // role/format scaffolding overhead
}
