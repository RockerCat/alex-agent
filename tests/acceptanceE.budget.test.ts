import { describe, it, expect } from "vitest";
import { runMarketingCycle } from "@/lib/agent/runtime";
import { BudgetGuard } from "@/lib/agent/budgetGuard";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import { ScriptedAiClient, createPlanOutput } from "@/tests/support/fakeAiClient";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// Spec acceptance test E: when the Budget Guard determines additional AI
// use is not allowed, the model call must be blocked before execution and
// the run must record a consistent BUDGET_BLOCKED outcome — never an
// auto-increased budget.

describe("Acceptance E — Budget Enforcement", () => {
  it("blocks the Planner call before it happens once the effective stop is reached", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake, { monthly_budget_usd: 10.0, safety_reserve_usd: 0.5 });
    // Effective stop is $9.50 — seed usage already at $9.60 spent this month.
    fake.seed("ai_usage", [
      {
        id: "usage-1",
        agent_run_id: null,
        brand: "solardesk",
        operation: "planner",
        model: "gpt-4.1",
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 1000,
        estimated_cost_usd: 9.6,
        created_at: new Date().toISOString(),
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const aiClient = new ScriptedAiClient([createPlanOutput()], []);

    const { run } = await runMarketingCycle({ db, aiClient, brand: "solardesk" });

    expect(run.status).toBe("skipped");
    expect(run.decision).toBe("BUDGET_BLOCKED");
    expect(aiClient.plannerCalls).toHaveLength(0);
    expect(fake.getAll("marketing_plans")).toHaveLength(0);
  });

  it("never exposes a way to auto-increase the budget from usage data alone", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const guard = new BudgetGuard(db);

    const before = await guard.getSnapshot();
    await guard.recordUsage({
      agentRunId: null,
      brand: "solardesk",
      operation: "planner",
      model: "gpt-4.1",
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 1000 },
    });
    const after = await guard.getSnapshot();

    expect(after.monthlyBudgetUsd).toBe(before.monthlyBudgetUsd);
    expect(after.monthlySpentUsd).toBeGreaterThan(before.monthlySpentUsd);
  });

  it("classifies budget threshold levels correctly", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake, { monthly_budget_usd: 10.0, safety_reserve_usd: 0.5 });
    fake.seed("ai_usage", [
      {
        id: "usage-1",
        agent_run_id: null,
        brand: "solardesk",
        operation: "planner",
        model: "gpt-4.1",
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        estimated_cost_usd: 8.0, // 80% of monthly budget -> warning band
        created_at: new Date().toISOString(),
      },
    ]);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);
    const guard = new BudgetGuard(db);
    const snapshot = await guard.getSnapshot();
    expect(snapshot.thresholdLevel).toBe("warning");
  });
});
