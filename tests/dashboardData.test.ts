import { describe, it, expect } from "vitest";
import { loadDashboardData } from "@/lib/agent/dashboardData";
import { createFakeDb, asSupabaseClient } from "@/tests/support/fakeDb";
import { seedDefaultSettings } from "@/tests/support/seed";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/database";

// The Dashboard must never present an `active` plan whose period has
// already ended as the "Current cycle" — that transition is Run
// Marketing Cycle's job (lib/agent/runtime.ts completeExpiredPlans),
// not the page's. This only affects what the Dashboard displays; it
// never writes to marketing_plans (see dashboardData.ts).

function seedActivationPlan(fake: ReturnType<typeof createFakeDb>, overrides: Record<string, unknown> = {}) {
  fake.seed("marketing_plans", [
    {
      id: "plan-1",
      brand: "solardesk",
      period_start: "2026-09-09",
      period_end: "2026-09-16",
      primary_objective: "ACTIVATION",
      primary_objective_reason: "r",
      primary_objective_success_signal: "s",
      supporting_objectives: [],
      strategy_summary: "sum",
      strategy_audience: "aud",
      strategy_approach: "app",
      rationale: "rat",
      status: "active",
      created_by_run: null,
      created_at: "2026-09-09T00:00:00Z",
      ...overrides,
    },
  ]);
}

describe("loadDashboardData — expired active plan is not shown as Current cycle", () => {
  it("period_end === today: plan is still shown as the current plan", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const data = await loadDashboardData(db, "2026-09-16");

    expect(data.activePlan).not.toBeNull();
    expect(data.activePlan?.id).toBe("plan-1");
  });

  it("period_end < today: the stale active plan is not shown, and the DB is untouched", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake);
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const data = await loadDashboardData(db, "2026-09-17");

    expect(data.activePlan).toBeNull();
    // No lifecycle mutation happened from the Dashboard read path.
    const plans = fake.getAll("marketing_plans");
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe("active");
  });

  it("a genuinely current plan (period_end in the future) is shown as before", async () => {
    const fake = createFakeDb();
    seedDefaultSettings(fake);
    seedActivationPlan(fake, { period_start: "2026-09-17", period_end: "2026-09-24" });
    const db = asSupabaseClient<SupabaseClient<Database>>(fake);

    const data = await loadDashboardData(db, "2026-09-17");

    expect(data.activePlan).not.toBeNull();
    expect(data.activePlan?.periodEnd).toBe("2026-09-24");
  });
});
