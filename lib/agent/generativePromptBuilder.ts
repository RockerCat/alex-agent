import type { VisualCreativePlan } from "@/lib/agent/schemas";

// Controlled prompt-builder layer (AlexAgent v0.2 — Visual Director).
// The Visual Director's `generativeSceneDescription` is never sent to
// the image provider verbatim/unmodified as a final prompt — it is only
// one bounded ingredient wrapped with fixed SolarDesk aesthetic
// constraints and an explicit, unconditional exclusion list. This is
// what keeps a scene description from becoming a path to generate the
// logo, UI, pricing, or any text that belongs to the approved draft
// (see brands/solardesk/VISUAL_IDENTITY.md section 6: generative
// imagery is for supporting elements only — backgrounds, ambient
// scenes, illustrations — never for content that must be exact).

const SOLARDESK_AESTHETIC_CONSTRAINTS =
  "Style: professional editorial photography/illustration for a B2B SaaS solar-industry brand. " +
  "Warm, natural lighting; clean, uncluttered composition; color palette that reads well alongside " +
  "a navy (#0F172A) and amber (#F59E0B) brand overlay. No text of any kind rendered in the image.";

// Deliberately explicit and unconditional — always appended regardless
// of what generativeSceneDescription asks for, so a scene description
// can never argue its way past these exclusions.
const REQUIRED_EXCLUSIONS =
  "Do not generate or include: any logo or brand wordmark, any app/software user interface, " +
  "any readable text, words, numbers, or captions of any kind, any invented pricing or metrics, " +
  "any dashboard, chart, or graph presented as real data, any document or proposal page design, " +
  "any watermark, or any screen/device mockup showing a fake interface.";

// Leaves the lower ~40% of the frame comparatively simple/uncluttered
// where possible, since the deterministic renderer composites a text
// scrim, headline, and CTA there (see assetRenderer.ts's hero
// composition) — a request, not a guarantee; the renderer's own scrim
// gradient is what actually guarantees legibility regardless of what
// the model returns.
const COMPOSITION_SPACE_HINT =
  "Leave the lower portion of the frame relatively simple and uncluttered, since text will be overlaid there.";

export interface BuiltGenerativePrompt {
  prompt: string;
}

/**
 * Pure function: validated plan in, safe bounded prompt string out. Only
 * ever called when plan.strategy is generated_photo/generated_illustration/
 * hybrid and plan.generativeSceneDescription is non-null (both enforced
 * by callers, not by this function, so a caller mistake fails loudly
 * rather than silently producing a degenerate prompt).
 */
export function buildGenerativeImagePrompt(plan: VisualCreativePlan): BuiltGenerativePrompt {
  if (!plan.generativeSceneDescription) {
    throw new Error("buildGenerativeImagePrompt requires a non-null generativeSceneDescription on the plan.");
  }

  const prompt = [
    `Scene: ${plan.generativeSceneDescription}`,
    SOLARDESK_AESTHETIC_CONSTRAINTS,
    COMPOSITION_SPACE_HINT,
    REQUIRED_EXCLUSIONS,
  ].join("\n\n");

  return { prompt };
}
