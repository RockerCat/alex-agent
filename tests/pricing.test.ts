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
    for (const known of [
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gpt-4o",
      "gpt-4o-mini",
    ]) {
      const p = getModelPricing(known);
      expect(fallback.inputPerMillion).toBeGreaterThanOrEqual(p.inputPerMillion);
      expect(fallback.cachedInputPerMillion).toBeGreaterThanOrEqual(p.cachedInputPerMillion);
      expect(fallback.outputPerMillion).toBeGreaterThanOrEqual(p.outputPerMillion);
    }
  });

  it("preCallEstimateUsd for an unmapped model still produces a positive pre-call reservation", () => {
    const estimate = preCallEstimateUsd("unmapped-model-xyz", 1000, 1000);
    expect(estimate).toBeGreaterThan(0);
  });
});

describe("pricing — confirmed production models (spec section 5)", () => {
  it("registers exact gpt-5.6-sol (Planner) pricing", () => {
    const pricing = getModelPricing("gpt-5.6-sol");
    expect(pricing).toEqual({
      inputPerMillion: 4.0,
      cachedInputPerMillion: 0.4,
      outputPerMillion: 20.0,
    });
  });

  it("registers exact gpt-5.6-luna (Executor) pricing", () => {
    const pricing = getModelPricing("gpt-5.6-luna");
    expect(pricing).toEqual({
      inputPerMillion: 0.2,
      cachedInputPerMillion: 0.02,
      outputPerMillion: 1.2,
    });
  });

  it("computes gpt-5.6-sol cost correctly for a representative Planner call", () => {
    // 10,000 input tokens (2,000 cached) + 1,500 output tokens.
    const cost = estimateCostUsd("gpt-5.6-sol", {
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_500,
    });
    const expected = (8_000 / 1_000_000) * 4.0 + (2_000 / 1_000_000) * 0.4 + (1_500 / 1_000_000) * 20.0;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it("computes gpt-5.6-luna cost correctly for a representative Executor call", () => {
    const cost = estimateCostUsd("gpt-5.6-luna", {
      inputTokens: 5_000,
      cachedInputTokens: 0,
      outputTokens: 1_200,
    });
    const expected = (5_000 / 1_000_000) * 0.2 + (1_200 / 1_000_000) * 1.2;
    expect(cost).toBeCloseTo(expected, 6);
  });
});
