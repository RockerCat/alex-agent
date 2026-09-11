import { selectProductScreenshot, type ScreenshotMeta } from "@/lib/agent/productScreenshots";
import { selectProposalExample, type ProposalExampleMeta } from "@/lib/agent/proposalExamples";
import type { VisualCreativePlan, VisualStrategy } from "@/lib/agent/schemas";

// Deterministic, allowlisted resolution from a validated VisualCreativePlan
// (which only ever carries a strategy enum + a source CATEGORY enum,
// never a file path — see schemas.ts) to real catalog metadata. This is
// the ONLY place a plan's intent is translated into an actual verified
// asset, and it only ever calls the existing authoritative catalog
// functions (productScreenshots.ts/proposalExamples.ts) — a model
// output can never reach a filesystem path directly, and references/
// is never consulted (those catalogs don't expose it).
//
// Pure and total: never throws. Any source that can't be safely
// resolved degrades the strategy to a strategy that needs no verified
// source (branded_graphic) rather than fabricating one — "never
// fabricate content" (spec section 11/18).

export interface ResolvedVisualSources {
  /** May differ from the plan's requested strategy if resolution failed — see `degraded`. */
  strategy: VisualStrategy;
  screenshotMeta: ScreenshotMeta | null;
  proposalMeta: ProposalExampleMeta | null;
  /** True once resolution needs a newly-produced (or previously cached) generative image to fully realize `strategy`. */
  needsGeneratedImage: boolean;
  degraded: boolean;
  degradeReason?: string;
}

export interface DraftSelectionInput {
  visualDirection: string;
  purpose: string;
  topic: string;
}

function resolveHybridVerifiedSource(
  plan: VisualCreativePlan,
  input: DraftSelectionInput
): { screenshotMeta: ScreenshotMeta | null; proposalMeta: ProposalExampleMeta | null } {
  if (plan.verifiedSourceCategory === "product_screenshot") {
    const screenshotMeta = selectProductScreenshot(input);
    if (screenshotMeta) return { screenshotMeta, proposalMeta: null };
    // Secondary fallback within the same catalog family before giving up the inset entirely.
    const proposalMeta = selectProposalExample(input);
    return { screenshotMeta: null, proposalMeta };
  }
  if (plan.verifiedSourceCategory === "proposal_example") {
    const proposalMeta = selectProposalExample(input);
    if (proposalMeta) return { screenshotMeta: null, proposalMeta };
    const screenshotMeta = selectProductScreenshot(input);
    return { screenshotMeta, proposalMeta: null };
  }
  return { screenshotMeta: null, proposalMeta: null };
}

export function resolveVisualSources(
  plan: VisualCreativePlan,
  input: DraftSelectionInput,
  generativeCapabilityAvailable: boolean
): ResolvedVisualSources {
  const requiresGenerative =
    plan.strategy === "generated_photo" || plan.strategy === "generated_illustration" || plan.strategy === "hybrid";

  // Never trust the model to have honored "generative capability is not
  // available this call" — enforce it structurally regardless of what
  // the plan says.
  if (requiresGenerative && !generativeCapabilityAvailable) {
    return {
      strategy: "branded_graphic",
      screenshotMeta: null,
      proposalMeta: null,
      needsGeneratedImage: false,
      degraded: true,
      degradeReason: "Generative imagery capability is not configured — degraded to branded_graphic.",
    };
  }

  switch (plan.strategy) {
    case "product_ui": {
      const screenshotMeta = selectProductScreenshot(input);
      if (!screenshotMeta) {
        return {
          strategy: "branded_graphic",
          screenshotMeta: null,
          proposalMeta: null,
          needsGeneratedImage: false,
          degraded: true,
          degradeReason: "No verified product screenshot matched this draft — degraded to branded_graphic.",
        };
      }
      return { strategy: "product_ui", screenshotMeta, proposalMeta: null, needsGeneratedImage: false, degraded: false };
    }
    case "proposal_document": {
      const proposalMeta = selectProposalExample(input);
      if (!proposalMeta) {
        return {
          strategy: "branded_graphic",
          screenshotMeta: null,
          proposalMeta: null,
          needsGeneratedImage: false,
          degraded: true,
          degradeReason: "No verified proposal example matched this draft — degraded to branded_graphic.",
        };
      }
      return { strategy: "proposal_document", screenshotMeta: null, proposalMeta, needsGeneratedImage: false, degraded: false };
    }
    case "generated_photo":
    case "generated_illustration":
      return { strategy: plan.strategy, screenshotMeta: null, proposalMeta: null, needsGeneratedImage: true, degraded: false };
    case "hybrid": {
      const { screenshotMeta, proposalMeta } = resolveHybridVerifiedSource(plan, input);
      return { strategy: "hybrid", screenshotMeta, proposalMeta, needsGeneratedImage: true, degraded: false };
    }
    case "branded_graphic":
    default:
      return { strategy: "branded_graphic", screenshotMeta: null, proposalMeta: null, needsGeneratedImage: false, degraded: false };
  }
}
