import type { AiClient, AssetFeedbackCallResult } from "@/lib/agent/aiClient";
import type { AssetRenderSpec } from "@/lib/agent/schemas";

// Narrow interpretation task: turn Alex's short natural-language visual
// feedback about an already-rendered SolarDesk image_post into a fully
// bounded AssetRenderSpec (lib/agent/schemas.ts), PLUS an explicit,
// bounded account of which parts of the feedback that render spec
// actually represents and which parts it doesn't (appliedChanges /
// unsupportedRequests — see assetFeedbackInterpretationSchema in
// schemas.ts). Uses the existing Executor model/configuration (see
// aiClient.ts's runAssetFeedbackInterpreter) — this is not a
// Planner-grade task and needs no reasoning effort. Still exactly one
// model call; appliedChanges/unsupportedRequests are extra fields on
// the SAME structured-output call, not a second call.
//
// The safety boundary here is structural, not just prompt wording: the
// Structured Outputs schema has no field for text, colors, coordinates,
// or file paths, so the model literally cannot emit any of those things
// regardless of what the feedback asks for. appliedChanges/
// unsupportedRequests are similarly bounded (short, capped-length,
// capped-count strings) and are explanatory metadata only — nothing
// downstream ever treats them as instructions.

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
  "If the feedback asks for anything outside these five fields (new claims, prices, wording, a different image, publishing, shadows or other visual effects, anything factual), do NOT try to satisfy it by changing an unrelated field to approximate it — leave the corresponding field(s) at their current value and report that specific request in unsupportedRequests instead.",
].join("\n");

const TRANSPARENCY_INSTRUCTIONS = [
  "Evaluate every distinct visual change Alex's feedback asks for, one at a time, against the five fields above:",
  "- If a requested change can be represented by one of these five fields at one of its allowed values, set that field accordingly and add a short (<=160 character) Spanish summary of what you applied to appliedChanges.",
  "- If a requested change cannot be represented by any of these five fields — a different kind of control entirely (e.g. shadows, borders, colors, spacing, new/removed elements), or a factual/text change — do not pretend to apply it and do not reinterpret it into a different, unrelated field just to avoid reporting it as unsupported. Instead add a short (<=160 character) Spanish summary of that specific request to unsupportedRequests, and leave every field it would have affected at its current value.",
  "renderSpec must always contain the complete spec (all five fields): fields tied to an applied change reflect that change, every other field carries over its current value unchanged.",
  "appliedChanges and unsupportedRequests are short human-readable summaries only, for display to Alex — never include code, coordinates, colors, prices, or new factual claims in them, only a brief description of the requested visual change itself.",
  "If the feedback contains no actionable visual request at all, return both lists empty and the current spec unchanged.",
].join("\n");

export function buildAssetFeedbackPrompt(context: AssetFeedbackContext): { system: string; user: string } {
  const system = [
    "You interpret a human's short natural-language visual feedback about an already-rendered SolarDesk marketing image into a small set of bounded rendering controls, and report which parts of the feedback you could and could not apply.",
    VISUAL_CONSTRAINTS,
    TRANSPARENCY_INSTRUCTIONS,
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
    TRANSPARENCY_INSTRUCTIONS.length +
    context.visualDirection.length +
    context.sourceDescription.length +
    context.feedback.length +
    400; // system prompt scaffolding + JSON.stringify(currentSpec) overhead
  return Math.ceil(approxChars / 4);
}
