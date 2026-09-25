import { describe, it, expect } from "vitest";
import { buildVisualDirectorPrompt, type VisualDirectorContext } from "@/lib/agent/visualDirector";
import { visualCreativePlanSchema, visualDirectorOutputSchema, DEFAULT_RENDER_SPEC, VISUAL_STRATEGIES } from "@/lib/agent/schemas";
import { visualPlan } from "@/tests/support/fakeAiClient";
import { emptyVisualHistory } from "@/lib/agent/visualHistory";

// AlexAgent v0.2 — Visual Director. Schema-level safety (structural, not
// prompt-wording) and prompt-construction behavior. The interpretation/
// resolution/rendering behavioral flow is covered end-to-end in
// tests/assetGenerator.test.ts's "Visual Director" describe block.

function baseContext(overrides: Partial<VisualDirectorContext> = {}): VisualDirectorContext {
  return {
    topic: "Explicar los supuestos también es parte de la propuesta",
    purpose: "education",
    audience: "Instaladores",
    hook: "¿Sabes qué supuestos hay detrás de tu propuesta?",
    ctaText: "Comenzar gratis",
    visualDirection: "",
    availableVerifiedSources: "product_screenshot: ...\nproposal_example: ...",
    channel: "facebook",
    generativeCapabilityAvailable: false,
    generativeBudget: { approxCostUsd: 0.02, budgetPermits: true },
    recentHistory: emptyVisualHistory(),
    ...overrides,
  };
}

describe("visualCreativePlanSchema — bounded structured output", () => {
  it("1. a valid plan parses successfully", () => {
    const result = visualCreativePlanSchema.safeParse(visualPlan());
    expect(result.success).toBe(true);
  });

  it("2. plan cannot contain arbitrary code/HTML/CSS — every field is either a fixed enum or a capped string; unknown fields are stripped, not executed", () => {
    const attempt = visualCreativePlanSchema.safeParse({
      ...visualPlan(),
      strategy: "<script>alert(1)</script>",
    });
    expect(attempt.success).toBe(false);

    const withExtraField = visualCreativePlanSchema.safeParse({
      ...visualPlan(),
      customCss: "body { display: none }",
      htmlPayload: "<div onclick='x()'>",
    });
    expect(withExtraField.success).toBe(true);
    expect((withExtraField as { success: true; data: object }).data).not.toHaveProperty("customCss");
    expect((withExtraField as { success: true; data: object }).data).not.toHaveProperty("htmlPayload");
  });

  it("3. plan cannot select an arbitrary filesystem path — verifiedSourceCategory is a fixed enum, no path/filename field exists on the schema at all", () => {
    const attempt = visualCreativePlanSchema.safeParse({
      ...visualPlan(),
      verifiedSourceCategory: "../../etc/passwd",
    });
    expect(attempt.success).toBe(false);

    const withPathField = visualCreativePlanSchema.safeParse({
      ...visualPlan(),
      screenshotFile: "../../etc/passwd",
      filePath: "/etc/passwd",
    });
    expect(withPathField.success).toBe(true);
    expect((withPathField as { success: true; data: object }).data).not.toHaveProperty("screenshotFile");
    expect((withPathField as { success: true; data: object }).data).not.toHaveProperty("filePath");
  });

  it("4. strategy is restricted to the six known values", () => {
    for (const strategy of VISUAL_STRATEGIES) {
      expect(visualCreativePlanSchema.safeParse(visualPlan({ strategy })).success).toBe(true);
    }
    expect(visualCreativePlanSchema.safeParse({ ...visualPlan(), strategy: "video_ad" }).success).toBe(false);
  });

  it("5. renderSpec reuses the exact same bounded five-field schema — no new rendering capability is introduced here", () => {
    const result = visualCreativePlanSchema.safeParse(visualPlan({ renderSpec: DEFAULT_RENDER_SPEC }));
    expect(result.success).toBe(true);
    const invalidSpec = visualCreativePlanSchema.safeParse({
      ...visualPlan(),
      renderSpec: { ...DEFAULT_RENDER_SPEC, primaryVisualScale: "gigantic" },
    });
    expect(invalidSpec.success).toBe(false);
  });

  it("6. the plan schema has no field capable of holding new copy/hook/CTA text — hook/CTA remain authoritative from the approved draft", () => {
    const shape = visualCreativePlanSchema.shape;
    const fieldNames = Object.keys(shape);
    expect(fieldNames).not.toContain("hook");
    expect(fieldNames).not.toContain("cta");
    expect(fieldNames).not.toContain("caption");
    expect(fieldNames).not.toContain("copy");
  });

  it("7. explanatory/creative text fields are length-bounded", () => {
    const tooLong = visualCreativePlanSchema.safeParse({
      ...visualPlan(),
      creativeConcept: "x".repeat(1000),
    });
    expect(tooLong.success).toBe(false);
  });
});

describe("buildVisualDirectorPrompt", () => {
  it("8. tells the model generative strategies are unavailable when capability is off, and available when on", () => {
    const off = buildVisualDirectorPrompt(baseContext({ generativeCapabilityAvailable: false }));
    expect(off.system).toMatch(/NOT available/);
    expect(off.system).toMatch(/Never choose generated_photo/);

    const on = buildVisualDirectorPrompt(baseContext({ generativeCapabilityAvailable: true }));
    expect(on.system).toMatch(/IS available/);
  });

  it("9. includes the compact recent history in the user prompt without any full historical binary content", () => {
    const { user } = buildVisualDirectorPrompt(
      baseContext({
        recentHistory: {
          windowDays: 45,
          entries: [
            {
              daysAgo: 9,
              channel: "facebook",
              status: "published",
              strategy: "proposal_document",
              strategySource: "legacy_inferred",
              layout: "proposal",
              theme: "b",
              sourceFingerprint: "proposal:propuesta-sistema-solar-residencial#p1+p2",
              generatedImage: false,
              topic: "De la cotización a una propuesta lista para presentar",
              creativeConcept: null,
            },
          ],
          summary: {
            strategyCounts: { proposal_document: 1 },
            sourceCounts: { "proposal:propuesta-sistema-solar-residencial#p1+p2": 1 },
            daysSinceLastUse: { proposal_document: 9 },
            recentPublished: [
              { daysAgo: 9, channel: "facebook", strategy: "proposal_document", layout: "proposal", sourceFingerprint: "proposal:propuesta-sistema-solar-residencial#p1+p2", generatedImage: false },
            ],
          },
        },
      })
    );
    expect(user).toMatch(/proposal_document/);
    expect(user).toMatch(/De la cotización a una propuesta lista para presentar/);
    expect(user).not.toMatch(/https?:\/\/|storage_path|render_provenance/);
  });

  it("10. instructs the model not to reproduce the logo/UI/proposal via generative imagery", () => {
    const { system } = buildVisualDirectorPrompt(baseContext());
    expect(system).toMatch(/logo must never be reproduced/i);
    expect(system).toMatch(/product UI and the real proposal document must never be reproduced/i);
  });

  it("11. does not send hook/CTA as something the model should rewrite — only surfaces them as read-only context", () => {
    const { user } = buildVisualDirectorPrompt(baseContext({ hook: "Mi hook aprobado", ctaText: "Mi CTA aprobado" }));
    expect(user).toContain("Mi hook aprobado");
    expect(user).toContain("Mi CTA aprobado");
    const { system } = buildVisualDirectorPrompt(baseContext());
    expect(system).toMatch(/never rewrite/i);
  });
});

describe("varietyRationale — new output requires it, stored plans stay compatible", () => {
  it("15. the Visual Director's output schema requires varietyRationale (bounded)", () => {
    expect(visualDirectorOutputSchema.safeParse(visualPlan()).success).toBe(false);
    expect(visualDirectorOutputSchema.safeParse(visualPlan({ varietyRationale: "Cambia respecto a las piezas recientes." })).success).toBe(true);
    expect(visualDirectorOutputSchema.safeParse(visualPlan({ varietyRationale: "x".repeat(301) })).success).toBe(false);
  });

  it("16. a stored plan persisted before varietyRationale existed still parses unchanged", () => {
    const parsed = visualCreativePlanSchema.safeParse(visualPlan());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(visualPlan());
  });
});

describe("buildVisualDirectorPrompt — variety and generative guidance", () => {
  it("presents every strategy family as legitimate, including generated photographic/lifestyle imagery for human-context posts", () => {
    const { system } = buildVisualDirectorPrompt(baseContext({ generativeCapabilityAvailable: true }));
    for (const strategy of VISUAL_STRATEGIES) expect(system).toContain(`- ${strategy}:`);
    expect(system).toMatch(/Generated photographic imagery is appropriate for conceptual, benefit-oriented, audience-oriented or human-context posts/);
    expect(system).toMatch(/do not default to generic solar-panel stock scenes/);
  });

  it("keeps relevance primary, explains feed repetition, allows justified repetition, and forbids mechanical rotation", () => {
    const { system } = buildVisualDirectorPrompt(baseContext());
    expect(system).toMatch(/Relevance to THIS approved draft is primary/);
    expect(system).toMatch(/followers see consecutive pieces in the same feed/);
    expect(system).toMatch(/Repetition is allowed when the content genuinely requires it/);
    expect(system).toMatch(/Do not rotate strategies mechanically/);
  });

  it("gives a factual cost/budget hint only when generation is available, and names Budget Guard as the final authority", () => {
    const permits = buildVisualDirectorPrompt(baseContext({ generativeCapabilityAvailable: true, generativeBudget: { approxCostUsd: 0.0198, budgetPermits: true } }));
    expect(permits.system).toMatch(/approximately \$0\.020 per low-quality generation; the current AI budget leaves room/);
    expect(permits.system).toMatch(/Budget Guard makes the final decision/);

    const blocked = buildVisualDirectorPrompt(baseContext({ generativeCapabilityAvailable: true, generativeBudget: { approxCostUsd: 0.02, budgetPermits: false } }));
    expect(blocked.system).toMatch(/does NOT leave room/);

    const off = buildVisualDirectorPrompt(baseContext({ generativeCapabilityAvailable: false }));
    expect(off.system).not.toMatch(/per low-quality generation/);
  });

  it("renders an empty history explicitly rather than omitting the section", () => {
    const { user } = buildVisualDirectorPrompt(baseContext());
    expect(user).toMatch(/=== Recent SolarDesk visual history \(last 45 days/);
    expect(user).toMatch(/no SolarDesk visual history in this window yet/);
  });
});
