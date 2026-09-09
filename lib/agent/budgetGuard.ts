import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";
import { estimateCostUsd, preCallEstimateUsd, type UsageTokens } from "@/lib/agent/pricing";
import { PER_RUN_AI_BUDGET_USD } from "@/lib/agent/constants";

export interface BudgetSnapshot {
  monthlyBudgetUsd: number;
  safetyReserveUsd: number;
  perRunBudgetUsd: number;
  monthlySpentUsd: number;
  effectiveStopUsd: number; // monthlyBudgetUsd - safetyReserveUsd
  monthlyUsagePct: number; // 0-100+, against monthlyBudgetUsd
  thresholdLevel: "ok" | "informational" | "warning" | "critical" | "blocked";
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  snapshot: BudgetSnapshot;
}

function monthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function classifyThreshold(pct: number, blocked: boolean): BudgetSnapshot["thresholdLevel"] {
  if (blocked || pct >= 100) return "blocked";
  if (pct >= 90) return "critical";
  if (pct >= 75) return "warning";
  if (pct >= 50) return "informational";
  return "ok";
}

/**
 * Server-side, database-authoritative AI budget enforcement.
 * Spec section 20: monthly budget is global (not per-brand), never
 * auto-increases, and must be checked *before* every AI operation.
 */
export class BudgetGuard {
  constructor(private readonly db: SupabaseClient<Database>) {}

  async getSnapshot(): Promise<BudgetSnapshot> {
    const { data: settings, error: settingsError } = await this.db
      .from("agent_settings")
      .select("*")
      .eq("singleton", true)
      .single();
    if (settingsError || !settings) {
      throw new Error(`Unable to load agent_settings: ${settingsError?.message}`);
    }

    const { data: usageRows, error: usageError } = await this.db
      .from("ai_usage")
      .select("estimated_cost_usd")
      .gte("created_at", monthStartIso());
    if (usageError) {
      throw new Error(`Unable to load ai_usage: ${usageError.message}`);
    }

    const monthlySpentUsd = (usageRows ?? []).reduce(
      (sum, row) => sum + Number(row.estimated_cost_usd ?? 0),
      0
    );

    const effectiveStopUsd = settings.monthly_budget_usd - settings.safety_reserve_usd;
    const monthlyUsagePct =
      settings.monthly_budget_usd > 0 ? (monthlySpentUsd / settings.monthly_budget_usd) * 100 : 100;
    const blocked = monthlySpentUsd >= effectiveStopUsd;

    return {
      monthlyBudgetUsd: settings.monthly_budget_usd,
      safetyReserveUsd: settings.safety_reserve_usd,
      perRunBudgetUsd: settings.per_run_budget_usd,
      monthlySpentUsd,
      effectiveStopUsd,
      monthlyUsagePct,
      thresholdLevel: classifyThreshold(monthlyUsagePct, blocked),
    };
  }

  private async getRunSpentUsd(agentRunId: string): Promise<number> {
    const { data, error } = await this.db
      .from("ai_usage")
      .select("estimated_cost_usd")
      .eq("agent_run_id", agentRunId);
    if (error) throw new Error(`Unable to load run usage: ${error.message}`);
    return (data ?? []).reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0);
  }

  /**
   * Must be called and must return allowed=true before any OpenAI call.
   * Checks both the global monthly effective stop and the per-run hard
   * limit, using a pessimistic pre-call cost estimate.
   */
  async checkBeforeCall(params: {
    agentRunId: string;
    model: string;
    approxInputTokens: number;
    approxMaxOutputTokens: number;
  }): Promise<BudgetCheckResult> {
    const snapshot = await this.getSnapshot();
    const estimate = preCallEstimateUsd(
      params.model,
      params.approxInputTokens,
      params.approxMaxOutputTokens
    );

    if (snapshot.monthlySpentUsd + estimate > snapshot.effectiveStopUsd) {
      return {
        allowed: false,
        reason: `Monthly AI budget effectively exhausted: $${snapshot.monthlySpentUsd.toFixed(
          2
        )} spent, $${snapshot.effectiveStopUsd.toFixed(2)} effective stop (reserve $${snapshot.safetyReserveUsd.toFixed(
          2
        )}).`,
        snapshot,
      };
    }

    const runSpent = await this.getRunSpentUsd(params.agentRunId);
    const perRunLimit = Math.min(snapshot.perRunBudgetUsd, PER_RUN_AI_BUDGET_USD);
    if (runSpent + estimate > perRunLimit) {
      return {
        allowed: false,
        reason: `Per-run AI budget exceeded: $${runSpent.toFixed(2)} spent this run, limit $${perRunLimit.toFixed(
          2
        )}.`,
        snapshot,
      };
    }

    return { allowed: true, snapshot };
  }

  /** Records actual usage after a model call completes. */
  async recordUsage(params: {
    agentRunId: string | null;
    brand: string;
    operation: "planner" | "executor";
    model: string;
    usage: UsageTokens;
  }): Promise<number> {
    const cost = estimateCostUsd(params.model, params.usage);
    const { error } = await this.db.from("ai_usage").insert({
      agent_run_id: params.agentRunId,
      brand: params.brand,
      operation: params.operation,
      model: params.model,
      input_tokens: params.usage.inputTokens,
      cached_input_tokens: params.usage.cachedInputTokens,
      output_tokens: params.usage.outputTokens,
      estimated_cost_usd: cost,
    });
    if (error) throw new Error(`Unable to record ai_usage: ${error.message}`);
    return cost;
  }
}
