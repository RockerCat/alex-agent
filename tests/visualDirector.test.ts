import { describe, it, expect } from "vitest";
import { buildVisualDirectorPrompt, type VisualDirectorContext } from "@/lib/agent/visualDirector";
import { visualCreativePlanSchema, DEFAULT_RENDER_SPEC, VISUAL_STRATEGIES } from "@/lib/agent/schemas";
import { visualPlan } from "@/tests/support/fakeAiClient";

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
    generativeCapabilityAvailable: false,
    recentHistory: [],
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

  it("9. includes bounded recent history in the user prompt without any full historical binary content", () => {
    const { user } = buildVisualDirectorPrompt(
      baseContext({
        recentHistory: [
          { topic: "De la cotización a una propuesta lista para presentar", purpose: "activation", strategy: "proposal_document", creativeConcept: "Mostrar el PDF final." },
        ],
      })
    );
    expect(user).toMatch(/proposal_document/);
    expect(user).toMatch(/Mostrar el PDF final\./);
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
