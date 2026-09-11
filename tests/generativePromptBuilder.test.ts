import { describe, it, expect } from "vitest";
import { buildGenerativeImagePrompt } from "@/lib/agent/generativePromptBuilder";
import { visualPlan } from "@/tests/support/fakeAiClient";

// AlexAgent v0.2 — controlled prompt-builder layer for generative
// imagery. The Visual Director's generativeSceneDescription is never
// sent to the provider unmodified; this always wraps it with fixed
// exclusions.

describe("buildGenerativeImagePrompt", () => {
  it("excludes logo/UI/pricing/factual-copy generation unconditionally, regardless of the scene description", () => {
    const { prompt } = buildGenerativeImagePrompt(
      visualPlan({
        strategy: "generated_photo",
        generativeSceneDescription: "A solar installer reviewing blueprints on a rooftop at sunrise.",
      })
    );
    expect(prompt).toMatch(/Do not generate or include/);
    expect(prompt).toMatch(/logo/i);
    expect(prompt).toMatch(/user interface/i);
    expect(prompt).toMatch(/readable text/i);
    expect(prompt).toMatch(/pricing/i);
    expect(prompt).toMatch(/watermark/i);
  });

  it("includes the scene description as scene content, not as an instruction that can override the exclusions", () => {
    const { prompt } = buildGenerativeImagePrompt(
      visualPlan({ strategy: "generated_illustration", generativeSceneDescription: "Abstract solar energy concept illustration." })
    );
    expect(prompt).toContain("Abstract solar energy concept illustration.");
    // The exclusion list is appended after the scene, always present regardless of scene content.
    const sceneIndex = prompt.indexOf("Abstract solar energy concept illustration.");
    const exclusionIndex = prompt.indexOf("Do not generate or include");
    expect(exclusionIndex).toBeGreaterThan(sceneIndex);
  });

  it("even a scene description that tries to ask for the logo/UI still ships with the same unconditional exclusion block appended after it", () => {
    const { prompt } = buildGenerativeImagePrompt(
      visualPlan({
        strategy: "hybrid",
        verifiedSourceCategory: "product_screenshot",
        generativeSceneDescription: "Show the SolarDesk logo and app dashboard clearly in the scene.",
      })
    );
    // The prompt builder does not strip/rewrite the scene text (that's
    // not its job — the schema/system-prompt is the primary defense);
    // what it guarantees is that the unconditional exclusion list is
    // always present after it, telling the provider not to comply.
    expect(prompt).toContain("Show the SolarDesk logo and app dashboard clearly in the scene.");
    expect(prompt).toMatch(/Do not generate or include:[\s\S]*logo/i);
  });

  it("throws rather than silently building a degenerate prompt when generativeSceneDescription is null", () => {
    const plan = visualPlan({ strategy: "generated_photo", generativeSceneDescription: null });
    expect(() => buildGenerativeImagePrompt(plan)).toThrow();
  });

  it("requests composition space for the deterministic text overlay", () => {
    const { prompt } = buildGenerativeImagePrompt(visualPlan({ strategy: "generated_photo", generativeSceneDescription: "A rooftop solar installation." }));
    expect(prompt).toMatch(/lower portion of the frame/i);
  });

  it("never includes SolarDesk factual claims/pricing not present in the scene description itself", () => {
    const { prompt } = buildGenerativeImagePrompt(
      visualPlan({ strategy: "generated_photo", generativeSceneDescription: "A homeowner and installer shaking hands outdoors." })
    );
    expect(prompt).not.toMatch(/30%|garantiza|guarantee/i);
  });
});
