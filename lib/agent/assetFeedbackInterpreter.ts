import type { AiClient, AssetFeedbackCallResult } from "@/lib/agent/aiClient";
import type { AssetRenderSpec } from "@/lib/agent/schemas";

// Narrow interpretation task: turn Alex's short natural-language visual
// feedback about an already-rendered SolarDesk image_post into a fully
// bounded AssetRenderSpec (lib/agent/schemas.ts). Uses the existing
// Executor model/configuration (see aiClient.ts's runAssetFeedbackInterpreter)
// — this is not a Planner-grade task and needs no reasoning effort.
//
// The safety boundary here is structural, not just prompt wording: the
// Structured Outputs schema has no field for text, colors, coordinates,
// or file paths, so the model literally cannot emit any of those things
// regardless of what the feedback asks for.

export type AssetCompositionLayout = "text-only" | "product-screenshot" | "proposal-example";

export interface AssetFeedbackContext {
  visualDirection: string;
  purpose: string;
  topic: string;
  layout: AssetCompositionLayout;
  /** Verified description of the current visual source, e.g. a screenshot's visibleSubject or the proposal example's verifiedPurpose — never the raw asset bytes. */
  sourceDescription: string;
  currentSpec: AssetRenderSpec;
  feedback: string;
}

const VISUAL_CONSTRAINTS = [
  "SolarDesk's brand colors (navy, amber, white) and the official logo file are fixed and cannot be changed.",
  "The product screenshot and the proposal-example PDF pages are fixed, verified real assets — they cannot be swapped for a different file, redrawn, or have any of their content/figures altered.",
  "You are not writing code, SVG, HTML, or CSS, and you are not choosing colors, fonts, sizes, coordinates, or file paths. You are only picking one value per field from that field's fixed list of allowed options.",
  "secondaryPageVisibility and disclosureEmphasis only affect the proposal-example composition; when the current layout is not proposal-example, keep them at their current values.",
  "disclosureEmphasis has no \"hidden\" option — the illustrative-example disclosure line must always remain visible; you can only make it more or less visually prominent.",
  "If the feedback asks for anything outside these five fields (new claims, prices, wording, a different image, publishing, anything factual), ignore that part entirely and keep the corresponding field(s) at their current value — never try to satisfy it some other way.",
].join("\n");

export function buildAssetFeedbackPrompt(context: AssetFeedbackContext): { system: string; user: string } {
  const system = [
    "You interpret a human's short natural-language visual feedback about an already-rendered SolarDesk marketing image into a small set of bounded rendering controls.",
    "Return the complete render spec (all five fields), reflecting the feedback where it applies and carrying over the current value for any field the feedback did not address.",
    VISUAL_CONSTRAINTS,
  ].join("\n");

  const user = [
    "=== Current composition ===",
    `Layout: ${context.layout}`,
    `Verified visual source: ${context.sourceDescription}`,
    `Approved visual direction: ${context.visualDirection || "(none)"}`,
    `Purpose: ${context.purpose}`,
    `Topic: ${context.topic}`,
    "",
    "=== Current render spec ===",
    JSON.stringify(context.currentSpec, null, 2),
    "",
    "=== Alex's feedback ===",
    context.feedback,
  ].join("\n");

  return { system, user };
}

export async function callAssetFeedbackInterpreter(
  aiClient: AiClient,
  context: AssetFeedbackContext
): Promise<AssetFeedbackCallResult> {
  const { system, user } = buildAssetFeedbackPrompt(context);
  return aiClient.runAssetFeedbackInterpreter({ systemPrompt: system, userPrompt: user });
}

export function estimateAssetFeedbackInputTokens(context: AssetFeedbackContext): number {
  const approxChars =
    VISUAL_CONSTRAINTS.length +
    context.visualDirection.length +
    context.sourceDescription.length +
    context.feedback.length +
    400; // system prompt scaffolding + JSON.stringify(currentSpec) overhead
  return Math.ceil(approxChars / 4);
}
