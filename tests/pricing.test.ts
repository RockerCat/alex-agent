import { describe, it, expect } from "vitest";
import { estimateCostUsd, preCallEstimateUsd, getModelPricing } from "@/lib/agent/pricing";

// Live-readiness audit: unknown/unconfigured models must not be treated as
// free. If Alex points OPENAI_PLANNER_MODEL/OPENAI_EXECUTOR_MODEL at a model
// id that isn't in the pricing table yet (e.g. while migrating to the real
// "GPT-5.6 Sol/Luna" ids), the Budget Guard must still estimate a
// conservative non-zero cost rather than silently assuming $0.

describe("pricing — unknown model fallback", () => {
  it("never returns zero pricing for an unrecognized model id", () => {
    const pricing = getModelPricing("gpt-5.6-sol-not-yet-in-table");
    expect(pricing.inputPerMillion).toBeGreaterThan(0);
    expect(pricing.cachedInputPerMillion).toBeGreaterThan(0);
    expect(pricing.outputPerMillion).toBeGreaterThan(0);
  });

  it("computes a non-zero estimated cost for an unrecognized model", () => {
    const cost = estimateCostUsd("totally-unknown-model", {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 2_000,
    });
    expect(cost).toBeGreaterThan(0);
  });

  it("the fallback price is at or above every known configured model, so switching models never under-reserves budget for an unmapped id", () => {
    const fallback = getModelPricing("some-future-unmapped-model");
    for (const known of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini"]) {
      const p = getModelPricing(known);
      expect(fallback.inputPerMillion).toBeGreaterThanOrEqual(p.inputPerMillion);
      expect(fallback.outputPerMillion).toBeGreaterThanOrEqual(p.outputPerMillion);
    }
  });

  it("preCallEstimateUsd for an unmapped model still produces a positive pre-call reservation", () => {
    const estimate = preCallEstimateUsd("unmapped-model-xyz", 1000, 1000);
    expect(estimate).toBeGreaterThan(0);
  });
});
