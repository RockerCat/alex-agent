import { describe, it, expect } from "vitest";
import { resolveVisualSources } from "@/lib/agent/visualSourceResolver";
import { visualPlan } from "@/tests/support/fakeAiClient";

// AlexAgent v0.2 — Visual Director source resolution. Pure, total,
// deterministic: a validated VisualCreativePlan (strategy enum + source
// CATEGORY enum, never a path) in, real catalog metadata (or a safe
// degrade to branded_graphic) out. This is the ONLY place a plan's
// intent becomes a real file, so these tests focus on: never fabricate,
// never select references/, never trust the model's capability claim.

const PROPOSAL_OUTPUT_INPUT = {
  visualDirection: "Muestra la propuesta final en PDF que SolarDesk entrega al cliente, lista para presentar.",
  purpose: "activation",
  topic: "El resultado: una propuesta profesional para tu cliente",
};

const PRODUCT_MANAGEMENT_INPUT = {
  visualDirection: "Mockup B2B SaaS mostrando la experiencia de propuestas de SolarDesk.",
  purpose: "activation",
  topic: "Gestiona tus propuestas solares",
};

const CONCEPTUAL_INPUT = {
  visualDirection: "SaaS B2B limpio, azul oscuro y ámbar.",
  purpose: "activation",
  topic: "Comienza gratis en SolarDesk",
};

describe("resolveVisualSources", () => {
  it("1. proposal_document resolves to the real verified proposal example", () => {
    const resolved = resolveVisualSources(visualPlan({ strategy: "proposal_document" }), PROPOSAL_OUTPUT_INPUT, false);
    expect(resolved.strategy).toBe("proposal_document");
    expect(resolved.proposalMeta).not.toBeNull();
    expect(resolved.proposalMeta?.pdfPath).toContain("proposal-examples/");
    expect(resolved.proposalMeta?.pdfPath).not.toContain("references");
    expect(resolved.screenshotMeta).toBeNull();
    expect(resolved.degraded).toBe(false);
  });

  it("2. product_ui resolves to a real verified product screenshot", () => {
    const resolved = resolveVisualSources(visualPlan({ strategy: "product_ui" }), PRODUCT_MANAGEMENT_INPUT, false);
    expect(resolved.strategy).toBe("product_ui");
    expect(resolved.screenshotMeta?.file).toBe("04.png");
    expect(resolved.proposalMeta).toBeNull();
    expect(resolved.degraded).toBe(false);
  });

  it("3. product_ui degrades safely to branded_graphic when no verified screenshot matches — never fabricates UI", () => {
    const resolved = resolveVisualSources(visualPlan({ strategy: "product_ui" }), CONCEPTUAL_INPUT, false);
    expect(resolved.strategy).toBe("branded_graphic");
    expect(resolved.screenshotMeta).toBeNull();
    expect(resolved.degraded).toBe(true);
    expect(resolved.degradeReason).toBeTruthy();
  });

  it("4. proposal_document degrades safely to branded_graphic when no verified proposal matches — never fabricates a proposal", () => {
    const resolved = resolveVisualSources(visualPlan({ strategy: "proposal_document" }), CONCEPTUAL_INPUT, false);
    expect(resolved.strategy).toBe("branded_graphic");
    expect(resolved.proposalMeta).toBeNull();
    expect(resolved.degraded).toBe(true);
  });

  it("5. branded_graphic never resolves a verified source even if the plan's verifiedSourceCategory says otherwise", () => {
    const resolved = resolveVisualSources(
      visualPlan({ strategy: "branded_graphic", verifiedSourceCategory: "proposal_example" }),
      PROPOSAL_OUTPUT_INPUT,
      false
    );
    expect(resolved.strategy).toBe("branded_graphic");
    expect(resolved.proposalMeta).toBeNull();
    expect(resolved.screenshotMeta).toBeNull();
    expect(resolved.needsGeneratedImage).toBe(false);
    expect(resolved.degraded).toBe(false);
  });

  it("6. generated_photo/generated_illustration are accepted (needsGeneratedImage=true) only when generative capability is available", () => {
    const available = resolveVisualSources(visualPlan({ strategy: "generated_photo" }), CONCEPTUAL_INPUT, true);
    expect(available.strategy).toBe("generated_photo");
    expect(available.needsGeneratedImage).toBe(true);
    expect(available.degraded).toBe(false);

    const unavailable = resolveVisualSources(visualPlan({ strategy: "generated_illustration" }), CONCEPTUAL_INPUT, false);
    expect(unavailable.strategy).toBe("branded_graphic");
    expect(unavailable.needsGeneratedImage).toBe(false);
    expect(unavailable.degraded).toBe(true);
    expect(unavailable.degradeReason).toMatch(/capability/i);
  });

  it("7. hybrid is accepted only when generative capability is available, and combines a generated image with one verified source category", () => {
    const withScreenshot = resolveVisualSources(
      visualPlan({ strategy: "hybrid", verifiedSourceCategory: "product_screenshot" }),
      PRODUCT_MANAGEMENT_INPUT,
      true
    );
    expect(withScreenshot.strategy).toBe("hybrid");
    expect(withScreenshot.needsGeneratedImage).toBe(true);
    expect(withScreenshot.screenshotMeta).not.toBeNull();
    expect(withScreenshot.proposalMeta).toBeNull();

    const withProposal = resolveVisualSources(
      visualPlan({ strategy: "hybrid", verifiedSourceCategory: "proposal_example" }),
      PROPOSAL_OUTPUT_INPUT,
      true
    );
    expect(withProposal.proposalMeta).not.toBeNull();
    expect(withProposal.screenshotMeta).toBeNull();

    const capabilityUnavailable = resolveVisualSources(
      visualPlan({ strategy: "hybrid", verifiedSourceCategory: "product_screenshot" }),
      PRODUCT_MANAGEMENT_INPUT,
      false
    );
    expect(capabilityUnavailable.strategy).toBe("branded_graphic");
    expect(capabilityUnavailable.degraded).toBe(true);
  });

  it("8. hybrid with verifiedSourceCategory 'none' still needs a generated image but has no inset card", () => {
    const resolved = resolveVisualSources(visualPlan({ strategy: "hybrid", verifiedSourceCategory: "none" }), CONCEPTUAL_INPUT, true);
    expect(resolved.strategy).toBe("hybrid");
    expect(resolved.needsGeneratedImage).toBe(true);
    expect(resolved.screenshotMeta).toBeNull();
    expect(resolved.proposalMeta).toBeNull();
    expect(resolved.degraded).toBe(false);
  });

  it("9. resolution never selects from references/ for any strategy", () => {
    const proposal = resolveVisualSources(visualPlan({ strategy: "proposal_document" }), PROPOSAL_OUTPUT_INPUT, false);
    expect(proposal.proposalMeta?.pdfPath ?? "").not.toContain("references");
    const screenshot = resolveVisualSources(visualPlan({ strategy: "product_ui" }), PRODUCT_MANAGEMENT_INPUT, false);
    expect(screenshot.screenshotMeta?.file ?? "").not.toMatch(/Camp_01|portada/);
  });
});
