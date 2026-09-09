// Centralized AI pricing (spec section 21: "Cost calculation must be
// centralized so model pricing can be updated without modifying agent
// business logic."). Prices are USD per 1M tokens. Update this table when
// OpenAI pricing changes or the configured model changes — nothing else
// in the codebase should need to change.

export interface ModelPricing {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  // Confirmed production models (spec section 5) — lib/env.ts defaults
  // OPENAI_PLANNER_MODEL / OPENAI_EXECUTOR_MODEL to these ids.
  "gpt-5.6-sol": { inputPerMillion: 4.0, cachedInputPerMillion: 0.4, outputPerMillion: 20.0 },
  "gpt-5.6-luna": { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2 },
  // Earlier placeholder models, kept in case either OPENAI_*_MODEL is
  // rolled back to one of these.
  "gpt-4.1": { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 },
  "gpt-4o": { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10.0 },
  "gpt-4o-mini": { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 },
};

// Conservative fallback for a model id not present in the table above —
// deliberately at or above every registered model's price on every axis,
// so an unrecognized/mis-configured model id never estimates cheaper than
// a real known model and can't silently bypass the budget guard.
const FALLBACK_PRICING: ModelPricing = {
  inputPerMillion: 5.0,
  cachedInputPerMillion: 2.5,
  outputPerMillion: 25.0,
};

export function getModelPricing(model: string): ModelPricing {
  return PRICING_TABLE[model] ?? FALLBACK_PRICING;
}

export interface UsageTokens {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function estimateCostUsd(model: string, usage: UsageTokens): number {
  const pricing = getModelPricing(model);
  const billableInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost =
    (billableInput / 1_000_000) * pricing.inputPerMillion +
    (usage.cachedInputTokens / 1_000_000) * pricing.cachedInputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Pre-call cost estimate used by the Budget Guard to decide whether a call
 * is even allowed to be attempted, before real usage is known. Deliberately
 * pessimistic (assumes no cached input, generous output) so it never
 * under-reserves budget.
 */
export function preCallEstimateUsd(
  model: string,
  approxInputTokens: number,
  approxMaxOutputTokens: number
): number {
  return estimateCostUsd(model, {
    inputTokens: approxInputTokens,
    cachedInputTokens: 0,
    outputTokens: approxMaxOutputTokens,
  });
}
