import { z } from "zod";
import {
  ALLOWED_CHANNELS,
  ALLOWED_CONTENT_TYPES,
  MAX_CONTENT_PER_CYCLE,
  OBJECTIVE_CATALOG,
  PLANNER_DECISIONS,
} from "@/lib/agent/constants";

// ---------------------------------------------------------------------
// Planner structured output (ALEXAGENT_V0.1_SPEC.md section 9)
// ---------------------------------------------------------------------

export const contentBriefSchema = z.object({
  purpose: z.string().min(1).max(200),
  channel: z.enum(ALLOWED_CHANNELS),
  format: z.enum(ALLOWED_CONTENT_TYPES),
  topic: z.string().min(1).max(300),
  audience: z.string().min(1).max(300),
  cta: z.string().min(1).max(200),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
export type ContentBrief = z.infer<typeof contentBriefSchema>;

export const plannerOutputSchema = z.object({
  decision: z.enum(PLANNER_DECISIONS),
  primaryObjective: z
    .object({
      type: z.enum(OBJECTIVE_CATALOG),
      reason: z.string().min(1).max(500),
      successSignal: z.string().min(1).max(300),
    })
    .nullable(),
  supportingObjectives: z.array(z.enum(OBJECTIVE_CATALOG)).max(2),
  strategy: z
    .object({
      summary: z.string().min(1).max(600),
      audience: z.string().min(1).max(300),
      approach: z.string().min(1).max(600),
    })
    .nullable(),
  content: z.array(contentBriefSchema).max(MAX_CONTENT_PER_CYCLE + 3), // over-cap tolerated, clamped later
  humanQuestion: z
    .object({
      question: z.string().min(1).max(400),
      reason: z.string().min(1).max(400),
    })
    .nullable(),
  rationale: z.string().min(1).max(800),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

// ---------------------------------------------------------------------
// Executor structured output (ALEXAGENT_V0.1_SPEC.md section 12)
// ---------------------------------------------------------------------

// Named so lib/agent/draftValidator.ts can check whether a generated
// string landed at EXACTLY its schema ceiling — a strong, mechanical
// signal that OpenAI's Structured Outputs constrained decoding (or the
// model itself, trying to respect the stated limit) force-closed the
// string mid-sentence rather than a coincidentally-short natural length.
//
// The original limits here (title 200, hook 300, slideText 500, cta
// 200, visualDirection 600) are the confirmed root cause of a live
// incident: a carousel slide and visualDirection were cut off mid-
// sentence in an otherwise syntactically valid, schema-compliant
// response — the Responses API's own maxLength enforcement clipped the
// string exactly at the JSON Schema `maxLength` derived from these
// `.max()` calls. Widened with real headroom so ordinary marketing
// copy (including a trailing caveat sentence) fits comfortably under
// the ceiling; `caption`'s existing 2200 was never implicated and is
// unchanged.
export const EXECUTOR_TEXT_LIMITS = {
  title: 260,
  hook: 400,
  slideText: 700,
  caption: 2200,
  cta: 260,
  visualDirection: 900,
} as const;

export const executorOutputSchema = z.object({
  title: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.title),
  hook: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.hook),
  slides: z
    .array(
      z.object({
        slide: z.number().int().min(1),
        text: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.slideText),
      })
    )
    .max(10),
  caption: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.caption),
  cta: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.cta),
  visualDirection: z.string().min(1).max(EXECUTOR_TEXT_LIMITS.visualDirection),
  hashtags: z.array(z.string().min(1).max(50)).max(15),
  // Set by the executor when it could not safely complete the brief
  // without relying on an unverifiable claim (Product Truth — spec section 19).
  unresolvedFactualGap: z
    .object({
      question: z.string().min(1).max(400),
      reason: z.string().min(1).max(400),
    })
    .nullable(),
});
export type ExecutorOutput = z.infer<typeof executorOutputSchema>;

// ---------------------------------------------------------------------
// Asset feedback interpreter structured output
// ---------------------------------------------------------------------
//
// Bounded rendering controls the current deterministic image_post
// renderer (lib/agent/assetRenderer.ts) knows how to safely execute.
// Deliberately NOT a generic layout/design schema: every field is an
// enum over a handful of preset, renderer-owned values — no free-form
// coordinates, colors, font sizes, file paths, or text. This is what
// keeps "interpret Alex's visual feedback" from ever becoming a
// backdoor for arbitrary code/markup generation or a Product Truth
// change: the model can only ever choose among these fixed values, it
// cannot emit anything else.
export const PRIMARY_VISUAL_SCALES = ["normal", "large", "dominant"] as const;
export const CTA_EMPHASIS_LEVELS = ["subtle", "normal", "strong"] as const;
export const LOGO_EMPHASIS_LEVELS = ["subtle", "normal", "strong"] as const;
export const SECONDARY_PAGE_VISIBILITY_LEVELS = ["hidden", "subtle", "normal"] as const;
// No "hidden" option here on purpose: the illustrative-example
// disclosure on a proposal-example composition is a safety-mandated
// element (see lib/agent/proposalExamples.ts's requiresFictitiousLabel)
// and feedback must never be able to remove it, only make it more or
// less visually prominent.
export const DISCLOSURE_EMPHASIS_LEVELS = ["subtle", "normal"] as const;

export const assetRenderSpecSchema = z.object({
  /** Size of the primary visual element (product screenshot card / proposal document stack). Ignored for the text-only composition, which has no primary visual to scale. */
  primaryVisualScale: z.enum(PRIMARY_VISUAL_SCALES),
  /** Size/boldness of the CTA pill. */
  ctaEmphasis: z.enum(CTA_EMPHASIS_LEVELS),
  /** Size of the official logo. */
  logoEmphasis: z.enum(LOGO_EMPHASIS_LEVELS),
  /** How much of the second (peeking) proposal page is shown. Only applies to the proposal-example composition. */
  secondaryPageVisibility: z.enum(SECONDARY_PAGE_VISIBILITY_LEVELS),
  /** Visual prominence of the mandatory "illustrative example" disclosure line. Only applies to the proposal-example composition; never hidden. */
  disclosureEmphasis: z.enum(DISCLOSURE_EMPHASIS_LEVELS),
});
export type AssetRenderSpec = z.infer<typeof assetRenderSpecSchema>;

// Reproduces today's renderer output exactly — every existing caller
// that does not pass a spec (or passes this one) gets byte-identical
// behavior to before this feature existed.
export const DEFAULT_RENDER_SPEC: AssetRenderSpec = {
  primaryVisualScale: "normal",
  ctaEmphasis: "normal",
  logoEmphasis: "normal",
  secondaryPageVisibility: "normal",
  disclosureEmphasis: "normal",
};

// ---------------------------------------------------------------------
// Asset feedback interpreter result — transparency, not new capability
// ---------------------------------------------------------------------
//
// AssetRenderSpec above stays the ONLY thing that can ever influence
// rendering. This wraps it with two purely explanatory, bounded lists
// of short human-readable summary strings so Alex's feedback can be
// evaluated field-by-field against the five real controls: what got
// applied, and what the feedback asked for that the current renderer
// simply cannot do. Neither list is free-form enough to carry
// executable instructions, copy, coordinates, colors, or file
// references — they're capped short strings, not structured
// instructions, and nothing downstream ever reads them for anything
// but display.
export const ASSET_FEEDBACK_SUMMARY_MAX_LENGTH = 160;
export const ASSET_FEEDBACK_SUMMARY_MAX_ITEMS = 6;

export const assetFeedbackInterpretationSchema = z.object({
  renderSpec: assetRenderSpecSchema,
  /** Short human-readable (Spanish) summaries of requested changes that WERE reflected in renderSpec above. Explanatory only — never fed back into rendering. */
  appliedChanges: z
    .array(z.string().min(1).max(ASSET_FEEDBACK_SUMMARY_MAX_LENGTH))
    .max(ASSET_FEEDBACK_SUMMARY_MAX_ITEMS),
  /** Short human-readable (Spanish) summaries of requested changes that could NOT be represented by the current five-field AssetRenderSpec. Explanatory only — never fed back into rendering. */
  unsupportedRequests: z
    .array(z.string().min(1).max(ASSET_FEEDBACK_SUMMARY_MAX_LENGTH))
    .max(ASSET_FEEDBACK_SUMMARY_MAX_ITEMS),
});
export type AssetFeedbackInterpretation = z.infer<typeof assetFeedbackInterpretationSchema>;
